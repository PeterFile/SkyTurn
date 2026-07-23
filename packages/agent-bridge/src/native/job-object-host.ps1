$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$source = @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class SkyTurnJobObjectHost
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint STILL_ACTIVE = 259;
    private const uint TerminatedExitCode = 0xC000013A;
    private const uint SetupFailureExitCode = 0xC0000142;

    public static int Run(
        string token,
        string pipeName,
        string executablePath,
        string[] arguments,
        string workingDirectory,
        int cleanupTimeoutMs)
    {
        ValidateInput(token, pipeName, executablePath, arguments, workingDirectory, cleanupTimeoutMs);
        using (NamedPipeClientStream control = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough))
        {
            control.Connect(15000);
            using (StreamReader reader = new StreamReader(control, new UTF8Encoding(false), false, 1024, true))
            using (StreamWriter writer = new StreamWriter(control, new UTF8Encoding(false), 1024, true))
            {
                writer.AutoFlush = true;
                return RunOwnedProcess(token, executablePath, arguments, workingDirectory, cleanupTimeoutMs, reader, writer);
            }
        }
    }

    private static int RunOwnedProcess(
        string token,
        string executablePath,
        string[] arguments,
        string workingDirectory,
        int cleanupTimeoutMs,
        StreamReader controlReader,
        StreamWriter controlWriter)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr processHandle = IntPtr.Zero;
        IntPtr threadHandle = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr nullInput = new IntPtr(-1);
        bool assigned = false;
        JobTerminationState terminationState = new JobTerminationState();
        Pump stdoutPump = null;
        Pump stderrPump = null;
        ControlState control = null;
        try
        {
            job = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
            EnsureHandle(job);
            ConfigureJob(job);

            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            attributes.bInheritHandle = true;
            Ensure(NativeMethods.CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0));
            Ensure(NativeMethods.SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0));
            Ensure(NativeMethods.CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0));
            Ensure(NativeMethods.SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0));
            nullInput = NativeMethods.CreateFileW(
                "NUL",
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref attributes,
                OPEN_EXISTING,
                0,
                IntPtr.Zero);
            EnsureHandle(nullInput);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = nullInput;
            startup.hStdOutput = stdoutWrite;
            startup.hStdError = stderrWrite;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(executablePath, arguments));
            Ensure(NativeMethods.CreateProcessW(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out process));
            processHandle = process.hProcess;
            threadHandle = process.hThread;
            CloseHandle(ref stdoutWrite);
            CloseHandle(ref stderrWrite);
            CloseHandle(ref nullInput);

            Ensure(NativeMethods.AssignProcessToJobObject(job, processHandle));
            assigned = true;
            if (QueryActiveProcesses(job) != 1) throw new InvalidOperationException();

            stdoutPump = new Pump(stdoutRead, Console.OpenStandardOutput());
            stdoutRead = IntPtr.Zero;
            stderrPump = new Pump(stderrRead, Console.OpenStandardError());
            stderrRead = IntPtr.Zero;
            stdoutPump.Start();
            stderrPump.Start();
            control = new ControlState(controlReader, ExpectedTerminateMessage(token));
            control.Start();

            if (NativeMethods.ResumeThread(threadHandle) == UInt32.MaxValue) throw new InvalidOperationException();
            WriteReady(controlWriter, token, process.dwProcessId);

            bool cancellation = false;
            for (;;)
            {
                int controlState = control.State;
                if (controlState == ControlState.TerminateRequested)
                {
                    cancellation = true;
                    break;
                }
                if (controlState == ControlState.Failed) throw new InvalidOperationException();
                uint wait = NativeMethods.WaitForSingleObject(processHandle, 20);
                if (wait == WAIT_OBJECT_0) break;
                if (wait != WAIT_TIMEOUT) throw new InvalidOperationException();
            }

            uint rootExitCode = 0;
            string termination;
            if (cancellation)
            {
                TerminateAndVerify(job, cleanupTimeoutMs, terminationState);
                termination = "cancelled";
            }
            else
            {
                Ensure(NativeMethods.GetExitCodeProcess(processHandle, out rootExitCode));
                if (rootExitCode == STILL_ACTIVE) throw new InvalidOperationException();
                uint activeProcesses = QueryActiveProcesses(job);
                if (activeProcesses > 0)
                {
                    TerminateAndVerify(job, cleanupTimeoutMs, terminationState);
                    termination = "descendants-terminated";
                }
                else
                {
                    termination = "normal";
                }
            }
            if (QueryActiveProcesses(job) != 0) throw new InvalidOperationException();
            if (!stdoutPump.Join(cleanupTimeoutMs) || !stderrPump.Join(cleanupTimeoutMs)) {
                throw new InvalidOperationException();
            }
            WriteClosed(controlWriter, token, cancellation ? (uint?)null : rootExitCode, termination);
            return 0;
        }
        catch
        {
            bool treeEmpty = ReapAfterFailure(job, processHandle, assigned, cleanupTimeoutMs, terminationState);
            try
            {
                WriteFailed(controlWriter, token, treeEmpty);
            }
            catch
            {
            }
            return 70;
        }
        finally
        {
            CloseHandle(ref threadHandle);
            CloseHandle(ref processHandle);
            CloseHandle(ref stdoutWrite);
            CloseHandle(ref stderrWrite);
            CloseHandle(ref stdoutRead);
            CloseHandle(ref stderrRead);
            CloseHandle(ref nullInput);
            CloseHandle(ref job);
            if (stdoutPump != null) stdoutPump.Dispose();
            if (stderrPump != null) stderrPump.Dispose();
        }
    }

    private static void ValidateInput(
        string token,
        string pipeName,
        string executablePath,
        string[] arguments,
        string workingDirectory,
        int cleanupTimeoutMs)
    {
        if (String.IsNullOrEmpty(token) || token.Length != 64 || !IsAsciiHex(token)) throw new InvalidDataException();
        if (String.IsNullOrEmpty(pipeName) || pipeName.Length > 200 || pipeName.IndexOfAny(new char[] { '\\', '/', '\0' }) >= 0) throw new InvalidDataException();
        if (String.IsNullOrEmpty(executablePath) || executablePath.Length > 32767 || !Path.IsPathRooted(executablePath) || !File.Exists(executablePath) || executablePath.IndexOf('\0') >= 0) throw new InvalidDataException();
        if (String.IsNullOrEmpty(workingDirectory) || workingDirectory.Length > 32767 || !Path.IsPathRooted(workingDirectory) || !Directory.Exists(workingDirectory) || workingDirectory.IndexOf('\0') >= 0) throw new InvalidDataException();
        if (arguments == null || arguments.Length > 1024) throw new InvalidDataException();
        foreach (string argument in arguments)
        {
            if (argument == null || argument.IndexOf('\0') >= 0) throw new InvalidDataException();
        }
        if (cleanupTimeoutMs < 1000 || cleanupTimeoutMs > 30000) throw new InvalidDataException();
    }

    private static bool IsAsciiHex(string value)
    {
        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
        }
        return true;
    }

    private static void ConfigureJob(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            Ensure(NativeMethods.SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size));
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static uint QueryActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        uint returnedLength;
        Ensure(NativeMethods.QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            out accounting,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
            out returnedLength));
        return accounting.ActiveProcesses;
    }

    private static void TerminateAndVerify(IntPtr job, int timeoutMs, JobTerminationState terminationState)
    {
        if (QueryActiveProcesses(job) > 0) Ensure(TerminateJobObjectOnce(job, terminationState));
        if (!WaitForTreeEmpty(job, timeoutMs)) throw new InvalidOperationException();
    }

    private static bool TerminateJobObjectOnce(IntPtr job, JobTerminationState terminationState)
    {
        if (!terminationState.TryBegin()) return true;
        return NativeMethods.TerminateJobObject(job, TerminatedExitCode);
    }

    private static bool WaitForTreeEmpty(IntPtr job, int timeoutMs)
    {
        MonotonicDeadline deadline = new MonotonicDeadline(timeoutMs);
        do
        {
            try
            {
                if (QueryActiveProcesses(job) == 0) return true;
            }
            catch
            {
                return false;
            }
            Thread.Sleep(10);
        }
        while (!deadline.IsReached());
        return false;
    }

    private sealed class MonotonicDeadline
    {
        private readonly long startedAt;
        private readonly long expiresAt;

        public MonotonicDeadline(int timeoutMs)
        {
            startedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            long timeoutTicks = TimeoutTicks(timeoutMs);
            expiresAt = startedAt > Int64.MaxValue - timeoutTicks ? Int64.MaxValue : startedAt + timeoutTicks;
        }

        public bool IsReached()
        {
            long current = System.Diagnostics.Stopwatch.GetTimestamp();
            if (current < startedAt) return true;
            return current >= expiresAt;
        }

        private static long TimeoutTicks(int timeoutMs)
        {
            long frequency = System.Diagnostics.Stopwatch.Frequency;
            if (frequency <= 0 || timeoutMs < 0) throw new InvalidOperationException();
            long seconds = timeoutMs / 1000;
            long milliseconds = timeoutMs % 1000;
            if (seconds > Int64.MaxValue / frequency) throw new InvalidOperationException();
            long wholeTicks = seconds * frequency;
            long remainderProduct = (frequency % 1000) * milliseconds;
            long partialTicks = (frequency / 1000) * milliseconds + (remainderProduct + 999) / 1000;
            if (wholeTicks > Int64.MaxValue - partialTicks) throw new InvalidOperationException();
            return wholeTicks + partialTicks;
        }
    }

    private sealed class JobTerminationState
    {
        public bool Attempted { get; private set; }

        public bool TryBegin()
        {
            if (Attempted) return false;
            Attempted = true;
            return true;
        }
    }

    private static bool ReapAfterFailure(
        IntPtr job,
        IntPtr processHandle,
        bool assigned,
        int timeoutMs,
        JobTerminationState terminationState)
    {
        if (assigned && job != IntPtr.Zero)
        {
            if (!terminationState.Attempted)
            {
                try
                {
                    if (QueryActiveProcesses(job) > 0 && !TerminateJobObjectOnce(job, terminationState)) return false;
                }
                catch
                {
                    return false;
                }
            }
            return WaitForTreeEmpty(job, timeoutMs);
        }

        if (processHandle != IntPtr.Zero)
        {
            try
            {
                uint exitCode;
                if (!NativeMethods.GetExitCodeProcess(processHandle, out exitCode)) return false;
                if (exitCode == STILL_ACTIVE && !NativeMethods.TerminateProcess(processHandle, SetupFailureExitCode)) return false;
                if (NativeMethods.WaitForSingleObject(processHandle, (uint)timeoutMs) != WAIT_OBJECT_0) return false;
            }
            catch
            {
                return false;
            }
        }

        return job == IntPtr.Zero || WaitForTreeEmpty(job, timeoutMs);
    }

    private static string BuildCommandLine(string executablePath, string[] arguments)
    {
        StringBuilder command = new StringBuilder(QuoteArgument(executablePath));
        foreach (string argument in arguments)
        {
            command.Append(' ');
            command.Append(QuoteArgument(argument));
        }
        if (command.Length >= 32767) throw new InvalidDataException();
        return command.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static string ExpectedTerminateMessage(string token)
    {
        return "{\"version\":1,\"token\":\"" + token + "\",\"kind\":\"terminate\"}";
    }

    private static void WriteReady(StreamWriter writer, string token, uint rootPid)
    {
        writer.WriteLine("{\"version\":1,\"token\":\"" + token + "\",\"kind\":\"ready\",\"rootPid\":" + rootPid + "}");
    }

    private static void WriteClosed(StreamWriter writer, string token, uint? exitCode, string termination)
    {
        string code = exitCode.HasValue ? exitCode.Value.ToString() : "null";
        writer.WriteLine("{\"version\":1,\"token\":\"" + token + "\",\"kind\":\"closed\",\"exitCode\":" + code + ",\"termination\":\"" + termination + "\",\"treeEmpty\":true}");
    }

    private static void WriteFailed(StreamWriter writer, string token, bool treeEmpty)
    {
        writer.WriteLine("{\"version\":1,\"token\":\"" + token + "\",\"kind\":\"failed\",\"stage\":\"setup\",\"treeEmpty\":" + (treeEmpty ? "true" : "false") + "}");
    }

    private static void Ensure(bool result)
    {
        if (!result) throw new InvalidOperationException();
    }

    private static void EnsureHandle(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new InvalidOperationException();
    }

    private static void CloseHandle(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
        NativeMethods.CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    private sealed class ControlState
    {
        public const int TerminateRequested = 1;
        public const int Failed = 2;
        private readonly StreamReader reader;
        private readonly string expected;
        private int state;

        public ControlState(StreamReader reader, string expected)
        {
            this.reader = reader;
            this.expected = expected;
        }

        public int State { get { return Interlocked.CompareExchange(ref state, 0, 0); } }

        public void Start()
        {
            Thread thread = new Thread(Read);
            thread.IsBackground = true;
            thread.Start();
        }

        private void Read()
        {
            try
            {
                string line = reader.ReadLine();
                Interlocked.CompareExchange(ref state, line == expected ? TerminateRequested : Failed, 0);
            }
            catch
            {
                Interlocked.CompareExchange(ref state, Failed, 0);
            }
        }
    }

    private sealed class Pump : IDisposable
    {
        private readonly FileStream input;
        private readonly Stream output;
        private readonly Thread thread;
        private bool failed;

        public Pump(IntPtr inputHandle, Stream output)
        {
            input = new FileStream(new SafeFileHandle(inputHandle, true), FileAccess.Read, 4096, false);
            this.output = output;
            thread = new Thread(Copy);
            thread.IsBackground = true;
        }

        public void Start() { thread.Start(); }

        public bool Join(int timeoutMs)
        {
            return thread.Join(timeoutMs) && !failed;
        }

        private void Copy()
        {
            byte[] buffer = new byte[8192];
            try
            {
                for (;;)
                {
                    int count = input.Read(buffer, 0, buffer.Length);
                    if (count == 0) break;
                    output.Write(buffer, 0, count);
                    output.Flush();
                }
            }
            catch
            {
                failed = true;
            }
        }

        public void Dispose() { input.Dispose(); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint informationLength, out uint returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateFileW(string path, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
'@

try {
    Add-Type -TypeDefinition $source -Language CSharp
    $requestLine = [Console]::In.ReadLine()
    if ($null -eq $requestLine -or $requestLine.Length -gt 262144) { throw "invalid request" }
    $request = $requestLine | ConvertFrom-Json
    if ($request.version -ne 1) { throw "invalid request" }
    $status = [SkyTurnJobObjectHost]::Run(
        [string]$request.token,
        [string]$request.pipeName,
        [string]$request.executablePath,
        [string[]]@($request.args),
        [string]$request.cwd,
        [int]$request.cleanupTimeoutMs)
    exit $status
}
catch {
    exit 70
}
