import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  PROTOCOL_METHODS,
  client,
  methods,
  type AnyMessage,
  type ClientConnection,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type Stream,
} from "@agentclientprotocol/sdk";

export interface HermesAcpClientOptions {
  executablePath?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  processCwd?: string;
  initializationTimeoutMs?: number;
  cancelTimeoutMs?: number;
  maxInboundLineBytes?: number;
  maxOutputBytes?: number;
  sessionRequestTimeoutMs?: number;
  signal?: AbortSignal;
  terminationGraceMs?: number;
}

export interface HermesAcpPromptOptions {
  timeoutMs?: number;
  onText?: (text: string) => void;
  redactProjectRoot?: string;
}

export interface HermesAcpPromptResult {
  stopReason: StopReason;
  markdown: string;
}

export interface HermesAcpClient {
  newSession(cwd: string): Promise<string>;
  loadSession(cwd: string, sessionId: string): Promise<void>;
  prompt(sessionId: string, prompt: string, options?: HermesAcpPromptOptions): Promise<HermesAcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}

interface ActivePrompt {
  chunks: string[];
  consumerFailed: boolean;
  outputBytes: number;
  outputFailure: Promise<never>;
  overflowed: boolean;
  redactor: StreamingKnownValueRedactor;
  rejectOutput: (error: Error) => void;
  onText?: (text: string) => void;
}

const defaultInitializationTimeoutMs = 10_000;
const defaultSessionRequestTimeoutMs = 30_000;
const defaultPromptTimeoutMs = 5 * 60_000;
const defaultCancelTimeoutMs = 250;
const maxPublicBytes = 2_000_000;
const defaultMaxInboundLineBytes = maxPublicBytes;
const defaultMaxOutputBytes = maxPublicBytes;
const defaultTerminationGraceMs = 1_000;
const outputLimitError = "Hermes ACP output limit exceeded.";
const outputConsumerError = "Hermes ACP output consumer failed.";
const inboundTransportError = "Hermes ACP inbound transport failed.";
const remoteOperationError = "Hermes ACP remote operation failed.";

interface AcpWireSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false };
}

interface AcpWireSchemas {
  zCancelRequestNotification: AcpWireSchema;
  zCompleteElicitationNotification: AcpWireSchema;
  zConnectMcpRequest: AcpWireSchema;
  zCreateElicitationRequest: AcpWireSchema;
  zCreateTerminalRequest: AcpWireSchema;
  zDisconnectMcpRequest: AcpWireSchema;
  zInitializeResponse: AcpWireSchema;
  zKillTerminalRequest: AcpWireSchema;
  zLoadSessionResponse: AcpWireSchema;
  zMessageMcpNotification: AcpWireSchema;
  zMessageMcpRequest: AcpWireSchema;
  zNewSessionResponse: AcpWireSchema;
  zPromptResponse: AcpWireSchema;
  zReadTextFileRequest: AcpWireSchema;
  zReleaseTerminalRequest: AcpWireSchema;
  zRequestPermissionRequest: AcpWireSchema;
  zSessionNotification: AcpWireSchema;
  zTerminalOutputRequest: AcpWireSchema;
  zWaitForTerminalExitRequest: AcpWireSchema;
  zWriteTextFileRequest: AcpWireSchema;
}

let acpWireSchemasPromise: Promise<AcpWireSchemas> | undefined;

export function denyHermesAcpPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

export async function createHermesAcpClient(
  options: HermesAcpClientOptions = {},
): Promise<HermesAcpClient> {
  const maxInboundLineBytes = boundedInteger(
    options.maxInboundLineBytes ?? defaultMaxInboundLineBytes,
    1,
    maxPublicBytes,
    "Hermes ACP initialization failed.",
  );
  const maxOutputBytes = boundedInteger(
    options.maxOutputBytes ?? defaultMaxOutputBytes,
    1,
    maxPublicBytes,
    "Hermes ACP initialization failed.",
  );
  const child = spawn(options.executablePath ?? "hermes", options.args ?? ["acp"], {
    cwd: options.processCwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const instance = new HermesAcpClientImpl(
    child,
    options.sessionRequestTimeoutMs ?? defaultSessionRequestTimeoutMs,
    options.cancelTimeoutMs ?? defaultCancelTimeoutMs,
    maxInboundLineBytes,
    maxOutputBytes,
    options.terminationGraceMs ?? defaultTerminationGraceMs,
  );
  try {
    await initializeWithAbort(
      instance,
      options.initializationTimeoutMs ?? defaultInitializationTimeoutMs,
      options.signal,
    );
    return instance;
  } catch {
    await instance.close();
    throw new Error("Hermes ACP initialization failed.");
  }
}

async function initializeWithAbort(
  instance: HermesAcpClientImpl,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await instance.initialize(timeoutMs);
    return;
  }
  let rejectAbort = (_error: Error): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => rejectAbort(new Error("Hermes ACP initialization aborted."));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await Promise.race([instance.initialize(timeoutMs), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

class HermesAcpClientImpl implements HermesAcpClient {
  private readonly activePrompts = new Map<string, ActivePrompt>();
  private readonly childClosed: Promise<void>;
  private readonly connection: ClientConnection;
  private childDidClose = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private supportsLoad = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly sessionRequestTimeoutMs: number,
    private readonly cancelTimeoutMs: number,
    maxInboundLineBytes: number,
    private readonly maxOutputBytes: number,
    private readonly terminationGraceMs: number,
  ) {
    this.child.stderr.on("data", () => {});
    this.childClosed = new Promise((resolve) => {
      child.once("error", () => {});
      child.once("close", () => {
        this.childDidClose = true;
        resolve();
      });
    });
    const app = client({ name: "skyturn-plan" })
      .onNotification(methods.client.session.update, ({ params }) => this.handleSessionUpdate(params));
    this.connection = app.connect(safeNdJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      maxInboundLineBytes,
    ));
  }

  async initialize(timeoutMs: number): Promise<void> {
    const result = await this.raceConnection(
      this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "SkyTurn", version: "0.1.0" },
      }),
      timeoutMs,
      "Hermes ACP initialization timed out.",
    );
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Hermes ACP protocol version is incompatible.");
    }
    this.supportsLoad = result.agentCapabilities?.loadSession === true;
  }

  async newSession(cwd: string): Promise<string> {
    assertAbsoluteCwd(cwd);
    try {
      const result = await this.raceConnection(
        this.connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        }),
        this.sessionRequestTimeoutMs,
        "Hermes ACP session creation timed out.",
      );
      return result.sessionId;
    } catch (error) {
      if (error instanceof Error && error.message === "Hermes ACP session creation timed out.") throw error;
      await this.reapAbortedConnection();
      throw new Error("Hermes ACP session creation failed.");
    }
  }

  async loadSession(cwd: string, sessionId: string): Promise<void> {
    assertAbsoluteCwd(cwd);
    if (!this.supportsLoad) throw new Error("Hermes ACP session loading is unavailable.");
    try {
      await this.raceConnection(
        this.connection.agent.request(methods.agent.session.load, {
          cwd,
          sessionId,
          mcpServers: [],
        }),
        this.sessionRequestTimeoutMs,
        "Hermes ACP session loading timed out.",
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Hermes ACP session loading timed out.") throw error;
      await this.reapAbortedConnection();
      throw new Error("Hermes ACP session loading failed.");
    }
  }

  async prompt(
    sessionId: string,
    prompt: string,
    options: HermesAcpPromptOptions = {},
  ): Promise<HermesAcpPromptResult> {
    if (this.activePrompts.has(sessionId)) throw new Error("Hermes ACP session already has an active prompt.");
    const active = this.createActivePrompt(sessionId, prompt, options.redactProjectRoot, options.onText);
    this.activePrompts.set(sessionId, active);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = options.timeoutMs ?? defaultPromptTimeoutMs;
      const request = this.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Hermes ACP prompt timed out."));
        }, timeoutMs);
      });
      const response = await Promise.race([
        request,
        timedOut,
        active.outputFailure,
        this.connectionFailure(),
      ]);
      active.redactor.flushTerminal();
      if (active.consumerFailed) throw new Error(outputConsumerError);
      if (active.overflowed) throw new Error(outputLimitError);
      if (response.stopReason !== "end_turn") throw new Error("Hermes ACP prompt stopped before completion.");
      return { stopReason: response.stopReason, markdown: active.chunks.join("") };
    } catch (error) {
      await this.reapAbortedConnection();
      if (error instanceof Error && error.message === outputConsumerError) {
        await this.close();
      }
      if (error instanceof Error && (error.message === "Hermes ACP prompt timed out." || error.message === outputLimitError)) {
        await this.close();
        throw error;
      }
      if (error instanceof Error && error.message === "Hermes ACP prompt stopped before completion.") throw error;
      throw new Error("Hermes ACP prompt failed.");
    } finally {
      if (timeout) clearTimeout(timeout);
      this.activePrompts.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.raceConnection(
        this.connection.agent.notify(methods.agent.session.cancel, { sessionId }),
        this.cancelTimeoutMs,
        "Hermes ACP cancellation timed out.",
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Hermes ACP cancellation timed out.") throw error;
      const connectionAborted = await this.reapAbortedConnection();
      if (connectionAborted) throw new Error("Hermes ACP cancellation failed.");
      if (!this.closed) throw new Error("Hermes ACP cancellation failed.");
    }
  }

  isClosed(): boolean {
    return this.closed || this.connection.signal.aborted;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    try {
      this.connection.close();
    } catch {}
    this.closePromise = this.terminateAndReap();
    return this.closePromise;
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const active = this.activePrompts.get(notification.sessionId);
    if (!active || active.consumerFailed || active.overflowed) return;
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
    active.redactor.write(update.content.text);
  }

  private async raceConnection<T>(request: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(timeoutMessage);
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(timeoutError), timeoutMs);
      });
      return await Promise.race([request, timedOut, this.connectionFailure()]);
    } catch (error) {
      if (error === timeoutError) await this.close();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async connectionFailure(): Promise<never> {
    await Promise.race([this.childClosed, this.connection.closed]);
    throw new Error("Hermes ACP connection closed.");
  }

  private async reapAbortedConnection(): Promise<boolean> {
    if (!this.connection.signal.aborted) return false;
    const newlyAborted = !this.closed;
    await this.close();
    return newlyAborted;
  }

  private createActivePrompt(
    sessionId: string,
    prompt: string,
    redactProjectRoot: string | undefined,
    onText: ((text: string) => void) | undefined,
  ): ActivePrompt {
    let rejectOutput = (_error: Error): void => {};
    const active = {
      chunks: [],
      consumerFailed: false,
      outputBytes: 0,
      outputFailure: new Promise<never>((_resolve, reject) => {
        rejectOutput = reject;
      }),
      overflowed: false,
      redactor: null as unknown as StreamingKnownValueRedactor,
      rejectOutput,
      ...(onText ? { onText } : {}),
    } satisfies ActivePrompt;
    active.rejectOutput = rejectOutput;
    active.redactor = new StreamingKnownValueRedactor(
      [
        { value: prompt, redactTerminalPrefix: true },
        ...(redactProjectRoot ? [{ value: redactProjectRoot, redactTerminalPrefix: true }] : []),
        { value: sessionId, redactTerminalPrefix: true },
      ],
      (text) => this.appendPromptOutput(active, text),
    );
    return active;
  }

  private appendPromptOutput(active: ActivePrompt, text: string): boolean {
    if (!text || active.consumerFailed || active.overflowed) return !active.consumerFailed && !active.overflowed;
    const bytes = Buffer.byteLength(text, "utf8");
    if (active.outputBytes + bytes > this.maxOutputBytes) {
      active.overflowed = true;
      active.rejectOutput(new Error(outputLimitError));
      return false;
    }
    active.outputBytes += bytes;
    active.chunks.push(text);
    try {
      active.onText?.(text);
    } catch {
      active.consumerFailed = true;
      active.rejectOutput(new Error(outputConsumerError));
      return false;
    }
    return true;
  }

  private async terminateAndReap(): Promise<void> {
    if (this.childDidClose) return;
    try {
      this.child.kill("SIGTERM");
    } catch {}
    if (await this.waitForChildClose(this.terminationGraceMs)) return;
    if (!this.childDidClose) {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }
    await this.childClosed;
  }

  private async waitForChildClose(timeoutMs: number): Promise<boolean> {
    if (this.childDidClose) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.childClosed.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

interface ExactRedactionTarget {
  value: string;
  redactTerminalPrefix: boolean;
}

class StreamingKnownValueRedactor {
  private readonly stages: ExactKnownValueRedactor[];

  constructor(
    targets: ExactRedactionTarget[],
    private readonly emit: (text: string) => boolean,
  ) {
    const uniqueTargets: ExactRedactionTarget[] = [];
    const targetIndexes = new Map<string, number>();
    for (const target of targets) {
      if (!target.value) continue;
      const existingIndex = targetIndexes.get(target.value);
      if (existingIndex === undefined) {
        targetIndexes.set(target.value, uniqueTargets.length);
        uniqueTargets.push({ ...target });
      } else if (target.redactTerminalPrefix) {
        uniqueTargets[existingIndex]!.redactTerminalPrefix = true;
      }
    }

    this.stages = new Array<ExactKnownValueRedactor>(uniqueTargets.length);
    let next = emit;
    for (let index = uniqueTargets.length - 1; index >= 0; index -= 1) {
      const target = uniqueTargets[index]!;
      const stage = new ExactKnownValueRedactor(target.value, target.redactTerminalPrefix, next);
      this.stages[index] = stage;
      next = (text) => stage.write(text);
    }
  }

  write(text: string): boolean {
    return this.stages[0]?.write(text) ?? this.emit(text);
  }

  flushTerminal(): void {
    for (const stage of this.stages) stage.flushTerminal();
  }
}

class ExactKnownValueRedactor {
  private readonly pattern: string[];
  private readonly prefix: number[];
  private readonly ready: string[] = [];
  private matched = 0;
  private readyLength = 0;
  private stopped = false;

  constructor(
    knownValue: string,
    private readonly redactTerminalPrefix: boolean,
    private readonly emit: (text: string) => boolean,
  ) {
    this.pattern = knownValue.split("");
    this.prefix = prefixTable(this.pattern);
  }

  write(text: string): boolean {
    if (this.stopped) return false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index] ?? "";
      while (this.matched > 0 && character !== this.pattern[this.matched]) {
        const fallback = this.prefix[this.matched - 1] ?? 0;
        this.queue(this.pattern.slice(0, this.matched - fallback).join(""));
        this.matched = fallback;
      }
      if (character === this.pattern[this.matched]) {
        this.matched += 1;
        if (this.matched === this.pattern.length) {
          this.queue("[redacted]");
          this.matched = 0;
        }
      } else {
        this.queue(character);
      }
      if (this.stopped) return false;
    }
    this.flushReady();
    return !this.stopped;
  }

  flushTerminal(): void {
    if (this.stopped) return;
    if (this.matched > 0) {
      this.queue(this.redactTerminalPrefix
        ? "[redacted]"
        : this.pattern.slice(0, this.matched).join(""));
    }
    this.matched = 0;
    this.flushReady();
  }

  private queue(text: string): void {
    if (!text || this.stopped) return;
    this.ready.push(text);
    this.readyLength += text.length;
    if (this.readyLength >= 4_096) this.flushReady();
  }

  private flushReady(): void {
    if (this.readyLength === 0 || this.stopped) return;
    const text = this.ready.join("");
    this.ready.length = 0;
    this.readyLength = 0;
    if (!this.emit(text)) this.stopped = true;
  }
}

function safeNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  maxInboundLineBytes: number,
): Stream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pendingResponseMethods = new Map<string | number | null, string>();
  let outputWrite = Promise.resolve();
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const writeWireMessage = (message: AnyMessage): Promise<void> => {
    const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
    const write = outputWrite.catch(() => undefined).then(async () => {
      const writer = output.getWriter();
      try {
        await writer.write(bytes);
      } catch {
        throw new Error(inboundTransportError);
      } finally {
        writer.releaseLock();
      }
    });
    outputWrite = write;
    return write;
  };
  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const wireSchemas = await loadAcpWireSchemas();
      const pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const append = (bytes: Uint8Array): void => {
        if (pendingBytes + bytes.byteLength > maxInboundLineBytes) throw new Error(inboundTransportError);
        if (bytes.byteLength > 0) pending.push(new Uint8Array(bytes));
        pendingBytes += bytes.byteLength;
      };
      const enqueue = async (): Promise<void> => {
        const line = new Uint8Array(pendingBytes);
        let offset = 0;
        for (const part of pending) {
          line.set(part, offset);
          offset += part.byteLength;
        }
        pending.length = 0;
        pendingBytes = 0;
        let text: string;
        try {
          text = decoder.decode(line).trim();
        } catch {
          throw new Error(inboundTransportError);
        }
        if (!text) return;
        let message: unknown;
        try {
          message = JSON.parse(text) as unknown;
        } catch {
          throw new Error(inboundTransportError);
        }
        if (!isJsonRpcMessage(message)) throw new Error(inboundTransportError);
        const intercepted = interceptedClientRequest(message, wireSchemas);
        if (intercepted) {
          await writeWireMessage(intercepted);
          return;
        }
        controller.enqueue(validateInboundAcpMessage(message, pendingResponseMethods, wireSchemas));
      };
      const reader = input.getReader();
      inputReader = reader;
      try {
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          let start = 0;
          for (let index = 0; index < value.byteLength; index += 1) {
            if (value[index] !== 0x0a) continue;
            append(value.subarray(start, index));
            await enqueue();
            start = index + 1;
          }
          append(value.subarray(start));
        }
        if (!cancelled && pendingBytes > 0) await enqueue();
      } catch {
        if (!cancelled) controller.error(new Error(inboundTransportError));
        return;
      } finally {
        if (inputReader === reader) inputReader = undefined;
        reader.releaseLock();
      }
      if (!cancelled) controller.close();
    },
    cancel(reason) {
      cancelled = true;
      return inputReader?.cancel(reason);
    },
  });
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const request = outboundRequest(message);
      if (request) pendingResponseMethods.set(request.id, request.method);
      try {
        await writeWireMessage(message);
      } catch {
        if (request) pendingResponseMethods.delete(request.id);
        throw new Error(inboundTransportError);
      }
    },
  });
  return { readable, writable };
}

function interceptedClientRequest(message: AnyMessage, schemas: AcpWireSchemas): AnyMessage | null {
  if (!("method" in message) || !("id" in message)) return null;
  const schema = inboundRequestSchemas(schemas).get(message.method);
  if (!schema) throw new Error(inboundTransportError);
  parseAcpValue(schema, message.params);
  if (message.method === CLIENT_METHODS.session_request_permission) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: denyHermesAcpPermission(),
    } as AnyMessage;
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "ACP client method is unsupported." },
  } as AnyMessage;
}

function loadAcpWireSchemas(): Promise<AcpWireSchemas> {
  acpWireSchemasPromise ??= import(
    new URL("./schema/zod.gen.js", import.meta.resolve("@agentclientprotocol/sdk")).href
  ).then((module) => module as unknown as AcpWireSchemas);
  return acpWireSchemasPromise;
}

function validateInboundAcpMessage(
  message: AnyMessage,
  pendingResponseMethods: Map<string | number | null, string>,
  schemas: AcpWireSchemas,
): AnyMessage {
  if ("method" in message) {
    const schema = "id" in message
      ? inboundRequestSchemas(schemas).get(message.method)
      : inboundNotificationSchemas(schemas).get(message.method);
    if (!schema) throw new Error(inboundTransportError);
    return { ...message, params: parseAcpValue(schema, message.params) } as AnyMessage;
  }

  const method = pendingResponseMethods.get(message.id);
  if (!method) throw new Error(inboundTransportError);
  pendingResponseMethods.delete(message.id);
  if ("error" in message) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: message.error.code, message: remoteOperationError },
    } as AnyMessage;
  }
  const schema = inboundResponseSchemas(schemas).get(method);
  if (!schema) throw new Error(inboundTransportError);
  return { ...message, result: parseAcpValue(schema, message.result) } as AnyMessage;
}

function inboundRequestSchemas(schemas: AcpWireSchemas): ReadonlyMap<string, AcpWireSchema> {
  return new Map([
    [CLIENT_METHODS.session_request_permission, schemas.zRequestPermissionRequest],
    [CLIENT_METHODS.fs_write_text_file, schemas.zWriteTextFileRequest],
    [CLIENT_METHODS.fs_read_text_file, schemas.zReadTextFileRequest],
    [CLIENT_METHODS.terminal_create, schemas.zCreateTerminalRequest],
    [CLIENT_METHODS.terminal_output, schemas.zTerminalOutputRequest],
    [CLIENT_METHODS.terminal_release, schemas.zReleaseTerminalRequest],
    [CLIENT_METHODS.terminal_wait_for_exit, schemas.zWaitForTerminalExitRequest],
    [CLIENT_METHODS.terminal_kill, schemas.zKillTerminalRequest],
    [CLIENT_METHODS.mcp_connect, schemas.zConnectMcpRequest],
    [CLIENT_METHODS.mcp_message, schemas.zMessageMcpRequest],
    [CLIENT_METHODS.mcp_disconnect, schemas.zDisconnectMcpRequest],
    [CLIENT_METHODS.elicitation_create, schemas.zCreateElicitationRequest],
  ]);
}

function inboundNotificationSchemas(schemas: AcpWireSchemas): ReadonlyMap<string, AcpWireSchema> {
  return new Map([
    [CLIENT_METHODS.session_update, schemas.zSessionNotification],
    [CLIENT_METHODS.mcp_message, schemas.zMessageMcpNotification],
    [CLIENT_METHODS.elicitation_complete, schemas.zCompleteElicitationNotification],
    [PROTOCOL_METHODS.cancel_request, schemas.zCancelRequestNotification],
  ]);
}

function inboundResponseSchemas(schemas: AcpWireSchemas): ReadonlyMap<string, AcpWireSchema> {
  return new Map([
    [methods.agent.initialize, schemas.zInitializeResponse],
    [methods.agent.session.new, schemas.zNewSessionResponse],
    [methods.agent.session.load, schemas.zLoadSessionResponse],
    [methods.agent.session.prompt, schemas.zPromptResponse],
  ]);
}

function parseAcpValue(schema: AcpWireSchema, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(inboundTransportError);
  return result.data;
}

function outboundRequest(
  message: AnyMessage,
): { id: string | number | null; method: string } | undefined {
  if (!("method" in message) || !("id" in message)) return undefined;
  return { id: message.id, method: message.method };
}

function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (typeof value.method === "string") {
    return !("id" in value) || isJsonRpcId(value.id);
  }
  if (!("id" in value) || !isJsonRpcId(value.id)) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return false;
  return !hasError || (
    isRecord(value.error) &&
    Number.isInteger(value.error.code) &&
    typeof value.error.message === "string"
  );
}

function isJsonRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function prefixTable(pattern: string[]): number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1] ?? 0;
    if (pattern[index] === pattern[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

function assertAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd)) throw new Error("Hermes ACP working directory must be absolute.");
}

function boundedInteger(value: number, minimum: number, maximum: number, error: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(error);
  return value;
}
