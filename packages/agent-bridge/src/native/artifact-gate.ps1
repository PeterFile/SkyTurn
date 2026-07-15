param(
    [switch]$Capability
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class ArtifactGateResult
{
    public string Status { get; set; }
    public string[] Artifacts { get; set; }
    public int Verified { get; set; }
    public int Missing { get; set; }
    public int Empty { get; set; }
    public int Unsafe { get; set; }
}

public sealed class ArtifactGateSession : IDisposable
{
    private const uint FILE_READ_ATTRIBUTES = 0x0080;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_TYPE_DISK = 0x0001;
    private const int FileStandardInfo = 1;
    private const int FileAttributeTagInfo = 9;
    private const int FileIdInfo = 18;
    private const uint VOLUME_NAME_NT = 0x2;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_PATH_NOT_FOUND = 3;
    private const int MaxArtifactCount = 32;
    private const int MaxArtifactLength = 1024;
    private const int MaxComponentCount = 64;
    private const int MaxPathLength = 32767;

    private readonly SafeFileHandle rootHandle;
    private readonly string rootPath;
    private readonly string rootDevicePath;
    private readonly string rootIdentity;
    private readonly List<RetainedHandle> retainedHandles = new List<RetainedHandle>();

    private ArtifactGateSession(SafeFileHandle rootHandle, string rootPath, string rootDevicePath, string rootIdentity)
    {
        this.rootHandle = rootHandle;
        this.rootPath = rootPath;
        this.rootDevicePath = rootDevicePath.TrimEnd('\\');
        this.rootIdentity = rootIdentity;
    }

    public static ArtifactGateSession Open(string root)
    {
        string fullRoot = ValidateLocalRoot(root);
        SafeFileHandle handle = OpenHandle(
            fullRoot,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
        );
        try
        {
            EnsureDisk(handle);
            FILE_ATTRIBUTE_TAG_INFO tags = GetAttributeTags(handle);
            FILE_STANDARD_INFO standard = GetStandardInfo(handle);
            if ((tags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || IsReparse(tags) ||
                !standard.Directory || standard.DeletePending)
                throw new InvalidDataException();
            string devicePath = GetDevicePath(handle);
            string identity = GetIdentity(handle);
            return new ArtifactGateSession(handle, fullRoot.TrimEnd('\\'), devicePath, identity);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public ArtifactGateResult Verify(string[] declarations)
    {
        ArtifactGateResult result = NewResult();
        if (declarations == null || declarations.Length == 0 || declarations.Length > MaxArtifactCount)
        {
            result.Unsafe = declarations == null || declarations.Length == 0 ? 1 : declarations.Length;
            return result;
        }

        List<string> accepted = new List<string>();
        HashSet<string> identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (string declaration in declarations)
        {
            string[] components;
            if (!TryValidateDeclaration(declaration, out components))
            {
                result.Unsafe++;
                continue;
            }
            ArtifactState state = InspectArtifact(declaration, components, identities);
            if (state == ArtifactState.Present)
            {
                result.Verified++;
                accepted.Add(declaration);
            }
            else if (state == ArtifactState.Missing) result.Missing++;
            else if (state == ArtifactState.Empty) result.Empty++;
            else result.Unsafe++;
        }
        if (result.Verified == declarations.Length && result.Missing == 0 && result.Empty == 0 && result.Unsafe == 0)
        {
            result.Status = "passed";
            result.Artifacts = accepted.ToArray();
        }
        return result;
    }

    public ArtifactGateResult Revalidate(ArtifactGateResult result)
    {
        if (result.Status != "passed") return result;
        EnsureDisk(rootHandle);
        FILE_ATTRIBUTE_TAG_INFO rootTags = GetAttributeTags(rootHandle);
        FILE_STANDARD_INFO rootStandard = GetStandardInfo(rootHandle);
        if ((rootTags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || IsReparse(rootTags) ||
            !rootStandard.Directory || rootStandard.DeletePending ||
            !String.Equals(GetDevicePath(rootHandle), rootDevicePath, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(GetIdentity(rootHandle), rootIdentity, StringComparison.Ordinal))
            throw new InvalidDataException();
        foreach (RetainedHandle retained in retainedHandles)
        {
            EnsureDisk(retained.Handle);
            FILE_ATTRIBUTE_TAG_INFO tags = GetAttributeTags(retained.Handle);
            FILE_STANDARD_INFO standard = GetStandardInfo(retained.Handle);
            if (IsReparse(tags) || !String.Equals(
                GetDevicePath(retained.Handle),
                retained.ExpectedDevicePath,
                StringComparison.OrdinalIgnoreCase
            ) || !IsExactChildPath(retained.ExpectedDevicePath) || !String.Equals(
                GetIdentity(retained.Handle),
                retained.ExpectedIdentity,
                StringComparison.Ordinal
            ))
                throw new InvalidDataException();
            bool directory = (tags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            if (standard.DeletePending || standard.Directory != directory ||
                (!retained.Final && !directory) || (retained.Final && (directory || standard.EndOfFile <= 0)))
                throw new InvalidDataException();
        }
        return result;
    }

    public void Dispose()
    {
        foreach (RetainedHandle retained in retainedHandles) retained.Handle.Dispose();
        retainedHandles.Clear();
        rootHandle.Dispose();
    }

    private ArtifactState InspectArtifact(string declaration, string[] components, HashSet<string> identities)
    {
        string prefix = rootPath;
        for (int index = 0; index < components.Length; index++)
        {
            bool final = index == components.Length - 1;
            prefix = prefix + "\\" + components[index];
            SafeFileHandle handle;
            try
            {
                handle = OpenHandle(
                    prefix,
                    final ? FILE_READ_ATTRIBUTES | GENERIC_READ : FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
                );
            }
            catch (Win32ExceptionWithCode error)
            {
                return error.Code == ERROR_FILE_NOT_FOUND || error.Code == ERROR_PATH_NOT_FOUND
                    ? ArtifactState.Missing
                    : ArtifactState.Unsafe;
            }

            string expectedDevicePath = rootDevicePath + "\\" + String.Join("\\", components, 0, index + 1);
            bool retained = false;
            try
            {
                EnsureDisk(handle);
                FILE_ATTRIBUTE_TAG_INFO tags = GetAttributeTags(handle);
                FILE_STANDARD_INFO standard = GetStandardInfo(handle);
                if (IsReparse(tags)) return ArtifactState.Unsafe;
                bool directory = (tags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                if (standard.DeletePending || standard.Directory != directory ||
                    (!final && !directory) || (final && directory)) return ArtifactState.Unsafe;
                string actualDevicePath = GetDevicePath(handle);
                if (!String.Equals(actualDevicePath, expectedDevicePath, StringComparison.OrdinalIgnoreCase))
                    return ArtifactState.Unsafe;
                if (!IsExactChildPath(actualDevicePath))
                    return ArtifactState.Unsafe;
                string identity = GetIdentity(handle);
                retainedHandles.Add(new RetainedHandle(handle, expectedDevicePath, identity, final));
                retained = true;
                if (!final) continue;

                if (!identities.Add(identity)) return ArtifactState.Unsafe;
                return standard.EndOfFile > 0 ? ArtifactState.Present : ArtifactState.Empty;
            }
            catch
            {
                return ArtifactState.Unsafe;
            }
            finally
            {
                if (!retained) handle.Dispose();
            }
        }
        return ArtifactState.Unsafe;
    }

    private bool IsExactChildPath(string path)
    {
        return path.StartsWith(rootDevicePath + "\\", StringComparison.OrdinalIgnoreCase);
    }

    private static string ValidateLocalRoot(string root)
    {
        if (String.IsNullOrEmpty(root) || root.Length > MaxPathLength || HasControl(root) ||
            root.StartsWith("\\\\", StringComparison.Ordinal) || root.Length < 3 || root[1] != ':' ||
            (root[2] != '\\' && root[2] != '/'))
            throw new InvalidDataException();
        string full = Path.GetFullPath(root);
        string pathRoot = Path.GetPathRoot(full);
        if (String.IsNullOrEmpty(pathRoot) || pathRoot.Length < 3 || pathRoot[1] != ':' || pathRoot[2] != '\\' ||
            full.IndexOf(':', 2) >= 0)
            throw new InvalidDataException();
        return full;
    }

    private static bool TryValidateDeclaration(string declaration, out string[] components)
    {
        components = null;
        if (String.IsNullOrEmpty(declaration) || declaration.Length > MaxArtifactLength || HasControl(declaration)) return false;
        if (!declaration.StartsWith(".devflow/acceptance/", StringComparison.Ordinal)) return false;
        if (declaration.IndexOf('\\') >= 0 || declaration.IndexOf(':') >= 0 || declaration.IndexOfAny(new char[] { '<', '>', '|', '?', '*' }) >= 0) return false;
        string[] parts = declaration.Split('/');
        if (parts.Length > MaxComponentCount) return false;
        foreach (string part in parts)
        {
            if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal)) return false;
            string stem = part.Split('.')[0].TrimEnd(' ', '.').ToUpperInvariant();
            if (IsReservedDeviceStem(stem)) return false;
        }
        components = parts;
        return true;
    }

    private static bool IsReservedDeviceStem(string stem)
    {
        if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
            stem == "CONIN$" || stem == "CONOUT$") return true;
        if (stem.Length != 4 || (!stem.StartsWith("COM", StringComparison.Ordinal) && !stem.StartsWith("LPT", StringComparison.Ordinal))) return false;
        char suffix = stem[3];
        return (suffix >= '1' && suffix <= '9') || suffix == '\u00b9' || suffix == '\u00b2' || suffix == '\u00b3';
    }

    private static bool HasControl(string value)
    {
        foreach (char character in value) if (character < 0x20 || character == 0x7f) return true;
        return false;
    }

    private static SafeFileHandle OpenHandle(string path, uint access, uint share, uint flags)
    {
        SafeFileHandle handle = NativeMethods.CreateFileW(path, access, share, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32ExceptionWithCode(Marshal.GetLastWin32Error());
        return handle;
    }

    private static void EnsureDisk(SafeFileHandle handle)
    {
        if (NativeMethods.GetFileType(handle) != FILE_TYPE_DISK) throw new InvalidDataException();
    }

    private static bool IsReparse(FILE_ATTRIBUTE_TAG_INFO info)
    {
        return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.ReparseTag != 0;
    }

    private static FILE_ATTRIBUTE_TAG_INFO GetAttributeTags(SafeFileHandle handle)
    {
        FILE_ATTRIBUTE_TAG_INFO value;
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out value, Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
            throw new InvalidDataException();
        return value;
    }

    private static FILE_STANDARD_INFO GetStandardInfo(SafeFileHandle handle)
    {
        FILE_STANDARD_INFO value;
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileStandardInfo, out value, Marshal.SizeOf(typeof(FILE_STANDARD_INFO))))
            throw new InvalidDataException();
        return value;
    }

    private static string GetIdentity(SafeFileHandle handle)
    {
        FILE_ID_INFO value;
        value.FileId = new byte[16];
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileIdInfo, out value, Marshal.SizeOf(typeof(FILE_ID_INFO))))
            throw new InvalidDataException();
        return value.VolumeSerialNumber.ToString("X16") + ":" + Convert.ToBase64String(value.FileId);
    }

    private static string GetDevicePath(SafeFileHandle handle)
    {
        char[] buffer = new char[1024];
        uint length = NativeMethods.GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, VOLUME_NAME_NT);
        if (length == 0 || length > MaxPathLength) throw new InvalidDataException();
        if (length >= buffer.Length)
        {
            buffer = new char[length + 1];
            length = NativeMethods.GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, VOLUME_NAME_NT);
            if (length == 0 || length >= buffer.Length) throw new InvalidDataException();
        }
        return new String(buffer, 0, (int)length).TrimEnd('\\');
    }

    private static ArtifactGateResult NewResult()
    {
        return new ArtifactGateResult
        {
            Status = "failed",
            Artifacts = new string[0],
            Verified = 0,
            Missing = 0,
            Empty = 0,
            Unsafe = 0
        };
    }

    private enum ArtifactState { Present, Missing, Empty, Unsafe }

    private sealed class RetainedHandle
    {
        public SafeFileHandle Handle { get; private set; }
        public string ExpectedDevicePath { get; private set; }
        public string ExpectedIdentity { get; private set; }
        public bool Final { get; private set; }

        public RetainedHandle(SafeFileHandle handle, string expectedDevicePath, string expectedIdentity, bool final)
        {
            Handle = handle;
            ExpectedDevicePath = expectedDevicePath;
            ExpectedIdentity = expectedIdentity;
            Final = final;
        }
    }

    private sealed class Win32ExceptionWithCode : Exception
    {
        public int Code { get; private set; }
        public Win32ExceptionWithCode(int code) { Code = code; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ATTRIBUTE_TAG_INFO
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_STANDARD_INFO
    {
        public long AllocationSize;
        public long EndOfFile;
        public uint NumberOfLinks;
        [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] public bool Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_INFO
    {
        public ulong VolumeSerialNumber;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] FileId;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetFileType(SafeFileHandle handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FILE_ATTRIBUTE_TAG_INFO value, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FILE_STANDARD_INFO value, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FILE_ID_INFO value, int size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, [Out] char[] path, uint pathLength, uint flags);
    }
}
'@

function Write-ProtocolResult([ArtifactGateResult]$result) {
    $payload = [ordered]@{
        version = 1
        status = $result.Status
        artifacts = @($result.Artifacts)
        counts = [ordered]@{
            verified = $result.Verified
            missing = $result.Missing
            empty = $result.Empty
            unsafe = $result.Unsafe
        }
    }
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
}

try {
    Add-Type -TypeDefinition $source -Language CSharp
    if ($Capability) {
        [Console]::Out.WriteLine('{"version":1,"status":"ready"}')
        exit 0
    }

    $requestLine = [Console]::In.ReadLine()
    if ($null -eq $requestLine -or $requestLine.Length -gt 65536) { throw "invalid request" }
    $request = $requestLine | ConvertFrom-Json
    if ($request.version -ne 1) { throw "invalid request" }
    $artifacts = [string[]]@($request.artifacts)
    $session = [ArtifactGateSession]::Open([string]$request.root)
    try {
        [Console]::Out.WriteLine("READY")
        if ([Console]::In.ReadLine() -ne "VERIFY") { throw "invalid command" }
        $result = $session.Verify($artifacts)
        [Console]::Out.WriteLine("OPENED")
        if ([Console]::In.ReadLine() -ne "COMMIT") { throw "invalid command" }
        $result = $session.Revalidate($result)
        Write-ProtocolResult $result
    }
    finally {
        $session.Dispose()
    }
    exit 0
}
catch {
    exit 70
}
