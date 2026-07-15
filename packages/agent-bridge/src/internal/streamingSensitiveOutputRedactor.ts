import type { TerminalOutputStream } from "@skyturn/project-core";

const carryLimit = 128;
const pathModeCarryLimit = carryLimit;
const patternUnitLimit = 65_536;
const outputBatchLength = 1_024;

export interface StreamingRedactorDiagnostics {
  operations: number;
  inputChars: number;
  chunks: number;
  boundedFrontierWork: number;
  retainedQueueChars: number;
  maxRetainedQueueChars: number;
  blockedCarryChars: number;
  maxBlockedCarryChars: number;
  frontierStates: number;
  maxFrontierStates: number;
}

export interface RedactedTerminalChunk {
  stream: TerminalOutputStream;
  text: string;
}

interface PendingChar {
  sequence: number;
  raw: string;
  output: string | null;
}

interface QueuedChunk {
  stream: TerminalOutputStream;
  chars: PendingChar[];
  charHead: number;
  textParts: string[];
  textBuffer: string[];
  textBufferChars: number;
  sealed: boolean;
}

interface SourceSpan {
  tokenIndex: number;
  start: number;
  end: number;
}

interface PatternMatch {
  start: number | null;
  end: number;
}

interface MatcherProgress {
  active: boolean;
  start: number | null;
}

interface MatcherNode {
  transitions: Map<string, number>;
  failure: number;
  depth: number;
  outputs: number[];
}

type RedactionMode =
  | { kind: "secret"; quote: "\"" | "'" | null; started: boolean }
  | {
      kind: "path";
      quote: "\"" | "'" | null;
      startSequence: number;
      retainedLength: number;
      overflowed: boolean;
    };

interface WindowsPathCandidate {
  startSequence: number;
  phase: "drive" | "colon";
  quote: "\"" | "'" | null;
}

const standardEscapes: Readonly<Record<string, string>> = {
  0: "\0",
  "\"": "\"",
  "'": "'",
  "\\": "\\",
  "/": "/",
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

const assignmentKeys = new Set([
  "api_key",
  "api-key",
  "apikey",
  "access_token",
  "access-token",
  "accesstoken",
  "refresh_token",
  "refresh-token",
  "refreshtoken",
  "id_token",
  "id-token",
  "idtoken",
  "token",
  "openai_api_key",
  "hermes_api_key",
  "anthropic_api_key",
  "password",
  "passwd",
  "credential",
  "secret",
]);

class StreamingPatternMatcher {
  private readonly nodes: MatcherNode[] = [{ transitions: new Map(), failure: 0, depth: 0, outputs: [] }];
  private readonly history: Array<SourceSpan | undefined> = new Array(carryLimit);
  private state = 0;
  private tokenIndex = -1;

  constructor(
    patterns: string[][],
    private readonly recordTransition: (count?: number) => void,
  ) {
    for (const pattern of patterns) this.addPattern(pattern);
    this.buildFailures();
  }

  feed(unit: string, sourceStart: number, sourceEnd: number): PatternMatch[] {
    this.tokenIndex += 1;
    this.history[this.tokenIndex % carryLimit] = {
      tokenIndex: this.tokenIndex,
      start: sourceStart,
      end: sourceEnd,
    };
    this.recordTransition();
    while (this.state !== 0 && !this.nodes[this.state]!.transitions.has(unit)) {
      this.recordTransition();
      this.state = this.nodes[this.state]!.failure;
    }
    const next = this.nodes[this.state]!.transitions.get(unit);
    this.state = next ?? 0;
    const matches: PatternMatch[] = [];
    for (const length of this.nodes[this.state]!.outputs) {
      this.recordTransition();
      matches.push({ start: this.sourceStart(length), end: sourceEnd });
    }
    return matches;
  }

  progress(): MatcherProgress {
    let candidate = this.state;
    while (candidate !== 0 && this.nodes[candidate]!.transitions.size === 0) {
      this.recordTransition();
      candidate = this.nodes[candidate]!.failure;
    }
    if (candidate === 0) return { active: false, start: null };
    return { active: true, start: this.sourceStart(this.nodes[candidate]!.depth) };
  }

  reset(): void {
    this.state = 0;
    this.tokenIndex = -1;
    this.history.fill(undefined);
  }

  private addPattern(pattern: string[]): void {
    if (pattern.length === 0) return;
    let state = 0;
    for (const unit of pattern) {
      let next = this.nodes[state]!.transitions.get(unit);
      if (next === undefined) {
        next = this.nodes.length;
        this.nodes[state]!.transitions.set(unit, next);
        this.nodes.push({
          transitions: new Map(),
          failure: 0,
          depth: this.nodes[state]!.depth + 1,
          outputs: [],
        });
      }
      state = next;
    }
    if (!this.nodes[state]!.outputs.includes(pattern.length)) {
      this.nodes[state]!.outputs.push(pattern.length);
    }
  }

  private buildFailures(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0]!.transitions.values()) queue.push(child);
    let head = 0;
    while (head < queue.length) {
      const state = queue[head++]!;
      for (const [unit, child] of this.nodes[state]!.transitions) {
        queue.push(child);
        let failure = this.nodes[state]!.failure;
        while (failure !== 0 && !this.nodes[failure]!.transitions.has(unit)) {
          failure = this.nodes[failure]!.failure;
        }
        this.nodes[child]!.failure = this.nodes[failure]!.transitions.get(unit) ?? 0;
        for (const length of this.nodes[this.nodes[child]!.failure]!.outputs) {
          if (!this.nodes[child]!.outputs.includes(length)) this.nodes[child]!.outputs.push(length);
        }
      }
    }
  }

  private sourceStart(length: number): number | null {
    if (length > carryLimit) return null;
    const index = this.tokenIndex - length + 1;
    const span = this.history[((index % carryLimit) + carryLimit) % carryLimit];
    return span?.tokenIndex === index ? span.start : null;
  }
}

class StreamingEscapeDecoder {
  private readonly pending: PendingChar[] = [];

  constructor(
    private readonly matcher: StreamingPatternMatcher,
    private readonly onMatches: (matches: PatternMatch[]) => void,
    private readonly recordOperation: (count?: number) => void,
  ) {}

  feed(char: PendingChar): void {
    this.recordOperation();
    if (this.pending.length === 0) {
      if (char.raw === "\\") {
        this.pending.push(char);
        return;
      }
      this.feedDecoded(char.raw, char.sequence, char.sequence);
      return;
    }

    this.pending.push(char);
    const kind = this.pending[1]?.raw;
    if (!kind) return;
    const standard = standardEscapes[kind];
    if (standard !== undefined) {
      this.feedDecoded(standard, this.pending[0]!.sequence, char.sequence);
      this.pending.length = 0;
      return;
    }
    const requiredLength = kind === "x" ? 4 : kind === "u" ? 6 : kind === "U" ? 10 : 0;
    if (requiredLength === 0) {
      this.replayPending();
      return;
    }
    const last = this.pending.at(-1)!.raw;
    if (this.pending.length > 2 && !/^[0-9a-f]$/i.test(last)) {
      this.replayPending();
      return;
    }
    if (this.pending.length < requiredLength) return;
    const digits = this.pending.slice(2).map((pending) => pending.raw).join("");
    const codePoint = Number.parseInt(digits, 16);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
      this.replayPending();
      return;
    }
    this.feedDecoded(String.fromCodePoint(codePoint), this.pending[0]!.sequence, char.sequence);
    this.pending.length = 0;
  }

  progress(): MatcherProgress {
    const matcherProgress = this.matcher.progress();
    if (this.pending.length === 0) return matcherProgress;
    const pendingStart = this.pending[0]!.sequence;
    return {
      active: true,
      start: matcherProgress.active && matcherProgress.start !== null
        ? Math.min(matcherProgress.start, pendingStart)
        : pendingStart,
    };
  }

  hasIncompleteEscape(): boolean {
    return this.pending.length > 0;
  }

  reset(): void {
    this.pending.length = 0;
    this.matcher.reset();
  }

  private replayPending(): void {
    const replay = this.pending.splice(0);
    for (const pending of replay) {
      this.feedDecoded(pending.raw, pending.sequence, pending.sequence);
    }
  }

  private feedDecoded(value: string, sourceStart: number, sourceEnd: number): void {
    for (const unit of value.split("")) {
      this.onMatches(this.matcher.feed(unit, sourceStart, sourceEnd));
    }
  }
}

class StreamingEncodedByteDecoder {
  private readonly pending: PendingChar[] = [];
  private readonly bytes: Array<{ value: number; start: number; end: number }> = [];
  private expectedBytes = 0;

  constructor(
    private readonly syntax: { start: string; marker?: string },
    private readonly matcher: StreamingPatternMatcher,
    private readonly onMatches: (matches: PatternMatch[]) => void,
    private readonly recordOperation: (count?: number) => void,
  ) {}

  feed(char: PendingChar): void {
    this.recordOperation();
    if (this.pending.length === 0) {
      if (char.raw === this.syntax.start) {
        this.pending.push(char);
        return;
      }
      this.flushIncompleteBytes();
      this.feedDecoded(char.raw, char.sequence, char.sequence);
      return;
    }
    this.pending.push(char);
    const digitOffset = this.syntax.marker ? 2 : 1;
    if (
      this.syntax.marker &&
      this.pending.length === 2 &&
      char.raw.toLowerCase() !== this.syntax.marker.toLowerCase()
    ) {
      this.flushIncompleteBytes();
      this.replayPending();
      return;
    }
    if (this.pending.length <= digitOffset) return;
    if (!/^[0-9a-f]$/i.test(char.raw)) {
      this.flushIncompleteBytes();
      this.replayPending();
      return;
    }
    const requiredLength = digitOffset + 2;
    if (this.pending.length < requiredLength) return;
    const value = Number.parseInt(
      `${this.pending[digitOffset]!.raw}${this.pending[digitOffset + 1]!.raw}`,
      16,
    );
    const start = this.pending[0]!.sequence;
    const end = char.sequence;
    this.pending.length = 0;
    this.acceptByte({ value, start, end });
  }

  progress(): MatcherProgress {
    const matcherProgress = this.matcher.progress();
    const bufferedStart = this.pending[0]?.sequence ?? this.bytes[0]?.start ?? null;
    if (bufferedStart === null) return matcherProgress;
    return {
      active: true,
      start: matcherProgress.active && matcherProgress.start !== null
        ? Math.min(matcherProgress.start, bufferedStart)
        : bufferedStart,
    };
  }

  hasIncompleteSequence(): boolean {
    return this.pending.length > 0 || this.bytes.length > 0;
  }

  reset(): void {
    this.pending.length = 0;
    this.bytes.length = 0;
    this.expectedBytes = 0;
    this.matcher.reset();
  }

  private acceptByte(byte: { value: number; start: number; end: number }): void {
    if (this.bytes.length === 0) {
      if (byte.value <= 0x7f) {
        this.feedDecoded(String.fromCharCode(byte.value), byte.start, byte.end);
        return;
      }
      this.expectedBytes = byte.value >= 0xc2 && byte.value <= 0xdf
        ? 2
        : byte.value >= 0xe0 && byte.value <= 0xef
          ? 3
          : byte.value >= 0xf0 && byte.value <= 0xf4
            ? 4
            : 0;
      if (this.expectedBytes === 0) {
        this.feedDecoded(String.fromCharCode(byte.value), byte.start, byte.end);
        return;
      }
      this.bytes.push(byte);
      return;
    }
    if (byte.value < 0x80 || byte.value > 0xbf) {
      this.flushIncompleteBytes();
      this.acceptByte(byte);
      return;
    }
    this.bytes.push(byte);
    if (this.bytes.length !== this.expectedBytes) return;
    const sourceStart = this.bytes[0]!.start;
    const sourceEnd = this.bytes.at(-1)!.end;
    const decoded = Buffer.from(this.bytes.map((item) => item.value)).toString("utf8");
    this.bytes.length = 0;
    this.expectedBytes = 0;
    this.feedDecoded(decoded, sourceStart, sourceEnd);
  }

  private flushIncompleteBytes(): void {
    for (const byte of this.bytes.splice(0)) {
      this.feedDecoded(String.fromCharCode(byte.value), byte.start, byte.end);
    }
    this.expectedBytes = 0;
  }

  private replayPending(): void {
    for (const pending of this.pending.splice(0)) {
      this.feedDecoded(pending.raw, pending.sequence, pending.sequence);
    }
  }

  private feedDecoded(value: string, sourceStart: number, sourceEnd: number): void {
    for (const unit of value.split("")) {
      this.onMatches(this.matcher.feed(unit, sourceStart, sourceEnd));
    }
  }
}

class RecentCharacters {
  private readonly values = new Array<string | undefined>(3);
  private count = 0;

  push(value: string): void {
    this.values[this.count % this.values.length] = value;
    this.count += 1;
  }

  previous(offset: number): string | undefined {
    if (offset < 0 || offset >= Math.min(this.count, this.values.length)) return undefined;
    return this.values[(this.count - 1 - offset) % this.values.length];
  }

  clear(): void {
    this.values.fill(undefined);
    this.count = 0;
  }
}

export class StreamingSensitiveOutputRedactor {
  private readonly queue: QueuedChunk[] = [];
  private queueHead = 0;
  private retainedQueueChars = 0;
  private sequence = 0;
  private readonly rawMatcher: StreamingPatternMatcher;
  private readonly foldedMatcher: StreamingPatternMatcher;
  private readonly escapedMatcher: StreamingPatternMatcher;
  private readonly shellByteMatcher: StreamingPatternMatcher;
  private readonly percentMatcher: StreamingPatternMatcher;
  private readonly escapeDecoder: StreamingEscapeDecoder;
  private readonly shellByteDecoder: StreamingEncodedByteDecoder;
  private readonly percentDecoder: StreamingEncodedByteDecoder;
  private readonly recent = new RecentCharacters();
  private mode: RedactionMode | null = null;
  private windowsPathCandidate: WindowsPathCandidate | null = null;
  private token = "";
  private assignmentCandidate = false;
  private previousWasSchemeColon = false;
  private overflowRedaction = false;
  private constructionFailedClosed = false;
  private failClosedMarkerEmitted = false;
  private lastRedactionEnd = -1;
  private currentMatched = false;
  private lastRaw: string | null = null;
  private sameRawRunLength = 0;

  constructor(
    sensitiveValues: string[] | undefined,
    private readonly diagnostics?: StreamingRedactorDiagnostics,
  ) {
    const values = [...new Set((sensitiveValues ?? []).filter(Boolean))];
    const patterns = sensitivePatterns(values);
    this.constructionFailedClosed = patterns.totalUnits > patternUnitLimit;
    const recordTransition = (count = 1) => this.recordFrontierOperations(count);
    this.rawMatcher = new StreamingPatternMatcher(
      this.constructionFailedClosed ? [] : patterns.raw,
      recordTransition,
    );
    this.foldedMatcher = new StreamingPatternMatcher(
      this.constructionFailedClosed ? [] : patterns.folded,
      recordTransition,
    );
    this.escapedMatcher = new StreamingPatternMatcher(
      this.constructionFailedClosed ? [] : patterns.escaped,
      recordTransition,
    );
    this.shellByteMatcher = new StreamingPatternMatcher(
      this.constructionFailedClosed ? [] : patterns.escaped,
      recordTransition,
    );
    this.percentMatcher = new StreamingPatternMatcher(
      this.constructionFailedClosed ? [] : patterns.escaped,
      recordTransition,
    );
    this.escapeDecoder = new StreamingEscapeDecoder(
      this.escapedMatcher,
      (matches) => this.applyMatches(matches),
      (count = 1) => this.recordOperations(count),
    );
    this.shellByteDecoder = new StreamingEncodedByteDecoder(
      { start: "\\", marker: "x" },
      this.shellByteMatcher,
      (matches) => this.applyMatches(matches),
      (count = 1) => this.recordOperations(count),
    );
    this.percentDecoder = new StreamingEncodedByteDecoder(
      { start: "%" },
      this.percentMatcher,
      (matches) => this.applyMatches(matches),
      (count = 1) => this.recordOperations(count),
    );
    this.updateDiagnostics();
  }

  push(stream: TerminalOutputStream, value: string): RedactedTerminalChunk[] {
    this.recordOperations();
    if (this.diagnostics) this.diagnostics.chunks += 1;
    if (!value) return [];
    if (this.constructionFailedClosed) return this.pushConstructionFailure(stream, value);

    const chunk: QueuedChunk = {
      stream,
      chars: [],
      charHead: 0,
      textParts: [],
      textBuffer: [],
      textBufferChars: 0,
      sealed: false,
    };
    this.queue.push(chunk);
    const output: RedactedTerminalChunk[] = [];
    for (const raw of value) {
      this.recordOperations();
      if (this.diagnostics) this.diagnostics.inputChars += 1;
      const char: PendingChar = { sequence: this.sequence, raw, output: null };
      this.sameRawRunLength = raw === this.lastRaw ? this.sameRawRunLength + 1 : 1;
      this.lastRaw = raw;
      this.sequence += 1;
      chunk.chars.push(char);
      this.retainedQueueChars += 1;
      this.updateDiagnostics();
      this.processChar(char);
      this.releaseResolved(char.sequence);
      this.drainReady(output);
    }
    chunk.sealed = true;
    this.drainReady(output);
    return output;
  }

  flush(): RedactedTerminalChunk[] {
    this.recordOperations();
    if (this.constructionFailedClosed) return [];
    if (this.mode?.kind === "path") {
      if (!this.mode.overflowed) {
        this.markRange(this.mode.startSequence, this.sequence - 1, true, "[redacted-path]");
      }
      this.mode = null;
    }
    this.windowsPathCandidate = null;
    const activeStart = this.activeStart();
    if (
      activeStart !== null &&
      (
        this.escapeDecoder.hasIncompleteEscape() ||
        this.shellByteDecoder.hasIncompleteSequence() ||
        this.percentDecoder.hasIncompleteSequence() ||
        this.sequence - activeStart > 1 ||
        this.sameRawRunLength === 1
      )
    ) {
      this.markRange(activeStart, this.sequence - 1);
    }
    this.resetExplicitChannels();
    this.mode = null;
    this.resetGenericState();
    this.releaseBefore(this.sequence);
    const output: RedactedTerminalChunk[] = [];
    this.drainReady(output);
    return output;
  }

  private processChar(char: PendingChar): void {
    this.currentMatched = false;
    if (this.mode) {
      this.processModeChar(char);
      return;
    }

    this.applyMatches(this.rawMatcher.feed(char.raw, char.sequence, char.sequence));
    this.applyMatches(this.foldedMatcher.feed(asciiFold(char.raw), char.sequence, char.sequence));
    this.escapeDecoder.feed(char);
    this.shellByteDecoder.feed(char);
    this.percentDecoder.feed(char);
    if (this.overflowRedaction) return;
    this.processGenericTrigger(char);
  }

  private processModeChar(char: PendingChar): void {
    const mode = this.mode!;
    if (mode.kind === "path") {
      if (isPathTerminator(char.raw, mode.quote)) {
        this.finishModeAndReplay(char);
        return;
      }
      mode.retainedLength += 1;
      if (mode.overflowed) {
        char.output = "";
        return;
      }
      if (mode.retainedLength >= pathModeCarryLimit) {
        this.markRange(mode.startSequence, char.sequence, true, "[redacted-path]");
        mode.overflowed = true;
      }
      return;
    }
    if (!mode.started) {
      if (char.raw === "\n") {
        this.finishModeAndReplay(char);
        return;
      }
      if (/^\s$/u.test(char.raw)) {
        char.output = char.raw;
        return;
      }
      if (char.raw === "\"" || char.raw === "'") {
        mode.quote = char.raw;
        char.output = char.raw;
        return;
      }
      mode.started = true;
      char.output = "[redacted]";
      return;
    }
    if (char.raw === "\n" || isSecretDelimiter(char.raw, mode.quote)) {
      this.finishModeAndReplay(char);
      return;
    }
    char.output = "";
  }

  private finishModeAndReplay(char: PendingChar): void {
    if (this.mode?.kind === "path" && !this.mode.overflowed) {
      this.markRange(this.mode.startSequence, char.sequence - 1, true, "[redacted-path]");
    }
    this.mode = null;
    this.resetGenericState();
    this.processChar(char);
  }

  private processGenericTrigger(char: PendingChar): void {
    this.recordOperations();
    const raw = char.raw;
    const pathStart = this.pathStart(char);
    if (pathStart !== null) {
      const previous = this.recent.previous(0);
      const quote = this.windowsPathCandidate?.quote ??
        (previous === "\"" || previous === "'" ? previous : null);
      this.windowsPathCandidate = null;
      this.enterMode({
        kind: "path",
        quote,
        startSequence: pathStart,
        retainedLength: char.sequence - pathStart + 1,
        overflowed: false,
      });
    }

    const isIdentifier = /^[A-Za-z0-9_-]$/.test(raw);
    let isSchemeColon = false;
    if (isIdentifier) {
      if (this.assignmentCandidate) this.assignmentCandidate = false;
      if (this.token.length < 64) this.token += raw.toLowerCase();
      else this.token = "";
      if (this.token === "sk-") this.enterMode({ kind: "secret", quote: null, started: false });
    } else if (/^\s$/u.test(raw)) {
      if (this.token === "bearer") this.enterMode({ kind: "secret", quote: null, started: false });
      this.assignmentCandidate ||= assignmentKeys.has(this.token);
      this.token = "";
    } else if (raw === ":" || raw === "=") {
      if (assignmentKeys.has(this.token) || this.assignmentCandidate) {
        this.enterMode({ kind: "secret", quote: null, started: false });
      }
      isSchemeColon = raw === ":" && /^[a-z][a-z0-9+.-]*$/i.test(this.token);
      this.token = "";
      this.assignmentCandidate = false;
    } else {
      this.token = "";
      this.assignmentCandidate = false;
    }
    this.previousWasSchemeColon = isSchemeColon;
    this.recent.push(raw);
  }

  private pathStart(char: PendingChar): number | null {
    const raw = char.raw;
    const previous = this.recent.previous(0);
    if (this.windowsPathCandidate) {
      if (this.windowsPathCandidate.phase === "drive" && raw === ":") {
        this.windowsPathCandidate.phase = "colon";
        return null;
      }
      if (this.windowsPathCandidate.phase === "colon" && (raw === "/" || raw === "\\")) {
        return this.windowsPathCandidate.startSequence;
      }
      this.windowsPathCandidate = null;
    }
    if (raw === "/") {
      if (!this.previousWasSchemeColon && (previous === undefined || /^[\s=:([{'"]$/u.test(previous))) {
        return char.sequence;
      }
    }
    if (/^[A-Za-z]$/.test(raw) && (previous === undefined || /^[\s=([{'"]$/u.test(previous))) {
      this.windowsPathCandidate = {
        startSequence: char.sequence,
        phase: "drive",
        quote: previous === "\"" || previous === "'" ? previous : null,
      };
    }
    return null;
  }

  private enterMode(mode: RedactionMode): void {
    if (this.mode) return;
    this.mode = mode;
    this.resetExplicitChannels();
  }

  private applyMatches(matches: PatternMatch[]): void {
    if (matches.length > 0) this.currentMatched = true;
    for (const match of matches) {
      if (match.start !== null) this.markRange(match.start, match.end);
      else if (!this.overflowRedaction) this.beginOverflowRedaction(match.end);
    }
  }

  private releaseResolved(currentSequence: number): void {
    const activeStart = this.activeStart();
    if (this.overflowRedaction && this.currentMatched && activeStart === null) {
      this.markRange(currentSequence, currentSequence, false);
      this.releaseBefore(currentSequence + 1);
      this.overflowRedaction = false;
      return;
    }
    if (activeStart !== null) {
      const activeLength = currentSequence - activeStart + 1;
      if (this.overflowRedaction || activeLength >= carryLimit) {
        if (!this.overflowRedaction) this.beginOverflowRedaction(currentSequence);
        else this.markRange(currentSequence, currentSequence, false);
        this.releaseBefore(currentSequence + 1);
        return;
      }
      this.releaseBefore(activeStart);
      return;
    }
    this.overflowRedaction = false;
    this.releaseBefore(currentSequence + 1);
  }

  private activeStart(): number | null {
    const progresses = [
      this.rawMatcher.progress(),
      this.foldedMatcher.progress(),
      this.escapeDecoder.progress(),
      this.shellByteDecoder.progress(),
      this.percentDecoder.progress(),
    ];
    const starts = progresses
      .filter((progress) => progress.active)
      .map((progress) => progress.start ?? this.firstPendingSequence())
      .filter((start): start is number => start !== null);
    if (this.mode?.kind === "path" && !this.mode.overflowed) starts.push(this.mode.startSequence);
    if (this.windowsPathCandidate) starts.push(this.windowsPathCandidate.startSequence);
    this.updateFrontierDiagnostics(
      progresses.filter((progress) => progress.active).length +
      (this.mode?.kind === "path" && !this.mode.overflowed ? 1 : 0) +
      (this.windowsPathCandidate ? 1 : 0),
    );
    return starts.length > 0 ? Math.min(...starts) : null;
  }

  private beginOverflowRedaction(end: number): void {
    const start = this.firstPendingSequence();
    if (start !== null) this.markRange(start, end);
    this.overflowRedaction = true;
    this.resetGenericState();
  }

  private markRange(
    start: number,
    end: number,
    includeMarker = true,
    marker: "[redacted]" | "[redacted-path]" = "[redacted]",
  ): void {
    const markerAllowed = includeMarker && (marker === "[redacted-path]" || start > this.lastRedactionEnd);
    this.lastRedactionEnd = Math.max(this.lastRedactionEnd, end);
    let markerWritten = false;
    for (let queueIndex = this.queueHead; queueIndex < this.queue.length; queueIndex += 1) {
      const chunk = this.queue[queueIndex]!;
      for (let index = chunk.charHead; index < chunk.chars.length; index += 1) {
        const char = chunk.chars[index]!;
        if (char.sequence < start) continue;
        if (char.sequence > end) return;
        this.recordFrontierOperations();
        if (markerAllowed && !markerWritten) {
          char.output = marker;
          markerWritten = true;
        } else if (char.output !== "[redacted]" && char.output !== "[redacted-path]") {
          char.output = "";
        }
      }
    }
  }

  private releaseBefore(sequence: number): void {
    for (let queueIndex = this.queueHead; queueIndex < this.queue.length; queueIndex += 1) {
      const chunk = this.queue[queueIndex]!;
      for (let index = chunk.charHead; index < chunk.chars.length; index += 1) {
        const char = chunk.chars[index]!;
        if (char.sequence >= sequence) return;
        if (char.output === null) char.output = char.raw;
      }
    }
  }

  private firstPendingSequence(): number | null {
    for (let queueIndex = this.queueHead; queueIndex < this.queue.length; queueIndex += 1) {
      const chunk = this.queue[queueIndex]!;
      const char = chunk.chars[chunk.charHead];
      if (char) return char.sequence;
    }
    return null;
  }

  private drainReady(output: RedactedTerminalChunk[]): void {
    while (this.queueHead < this.queue.length) {
      const chunk = this.queue[this.queueHead]!;
      while (chunk.charHead < chunk.chars.length) {
        const char = chunk.chars[chunk.charHead]!;
        if (char.output === null) return;
        this.appendChunkText(chunk, char.output);
        chunk.charHead += 1;
        this.retainedQueueChars -= 1;
        this.recordOperations();
        this.updateDiagnostics();
      }
      chunk.chars.length = 0;
      chunk.charHead = 0;
      if (!chunk.sealed) return;
      this.flushChunkTextBuffer(chunk);
      output.push({ stream: chunk.stream, text: chunk.textParts.join("") });
      this.recordOperations(chunk.textParts.reduce((total, part) => total + part.length, 0) + 2);
      chunk.textParts.length = 0;
      this.queueHead += 1;
    }
    this.queue.length = 0;
    this.queueHead = 0;
  }

  private appendChunkText(chunk: QueuedChunk, text: string): void {
    if (!text) return;
    chunk.textBuffer.push(text);
    chunk.textBufferChars += text.length;
    this.recordOperations();
    if (chunk.textBuffer.length >= outputBatchLength) this.flushChunkTextBuffer(chunk);
  }

  private flushChunkTextBuffer(chunk: QueuedChunk): void {
    if (chunk.textBuffer.length === 0) return;
    chunk.textParts.push(chunk.textBuffer.join(""));
    this.recordOperations(chunk.textBufferChars + 1);
    chunk.textBuffer.length = 0;
    chunk.textBufferChars = 0;
  }

  private resetExplicitChannels(): void {
    this.rawMatcher.reset();
    this.foldedMatcher.reset();
    this.escapeDecoder.reset();
    this.shellByteDecoder.reset();
    this.percentDecoder.reset();
    this.overflowRedaction = false;
    this.updateFrontierDiagnostics(0);
  }

  private resetGenericState(): void {
    this.token = "";
    this.assignmentCandidate = false;
    this.previousWasSchemeColon = false;
    this.windowsPathCandidate = null;
    this.recent.clear();
  }

  private pushConstructionFailure(stream: TerminalOutputStream, value: string): RedactedTerminalChunk[] {
    const inputChars = Array.from(value).length;
    if (this.diagnostics) this.diagnostics.inputChars += inputChars;
    this.recordOperations(inputChars + 1);
    if (this.failClosedMarkerEmitted) return [];
    this.failClosedMarkerEmitted = true;
    return [{ stream, text: "[redacted]" }];
  }

  private recordOperations(count = 1): void {
    if (this.diagnostics) this.diagnostics.operations += count;
  }

  private recordFrontierOperations(count = 1): void {
    if (!this.diagnostics) return;
    this.diagnostics.operations += count;
    this.diagnostics.boundedFrontierWork += count;
  }

  private updateDiagnostics(): void {
    if (!this.diagnostics) return;
    this.diagnostics.retainedQueueChars = this.retainedQueueChars;
    this.diagnostics.maxRetainedQueueChars = Math.max(
      this.diagnostics.maxRetainedQueueChars,
      this.retainedQueueChars,
    );
    this.diagnostics.blockedCarryChars = this.retainedQueueChars;
    this.diagnostics.maxBlockedCarryChars = Math.max(
      this.diagnostics.maxBlockedCarryChars,
      this.retainedQueueChars,
    );
  }

  private updateFrontierDiagnostics(activeStates: number): void {
    if (!this.diagnostics) return;
    this.diagnostics.frontierStates = activeStates;
    this.diagnostics.maxFrontierStates = Math.max(
      this.diagnostics.maxFrontierStates,
      activeStates,
    );
  }
}

function sensitivePatterns(values: string[]): {
  raw: string[][];
  folded: string[][];
  escaped: string[][];
  totalUnits: number;
} {
  const raw = new Set<string>();
  const folded = new Set<string>();
  const escaped = new Set<string>();
  for (const value of values) {
    raw.add(value);
    escaped.add(value);
    const bytes = Buffer.from(value, "utf8");
    const base64 = bytes.toString("base64");
    raw.add(base64);
    raw.add(base64.replace(/=+$/, ""));
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_");
    raw.add(base64url);
    raw.add(base64url.replace(/=+$/, ""));
    folded.add([...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
    folded.add(bytes.toString("hex"));
  }
  const rawPatterns = [...raw].filter(Boolean).map((pattern) => Array.from(pattern));
  const foldedPatterns = [...folded].filter(Boolean).map((pattern) => Array.from(pattern));
  const escapedPatterns = [...escaped].filter(Boolean).map((pattern) => pattern.split(""));
  const totalUnits = [
    ...rawPatterns,
    ...foldedPatterns,
    ...escapedPatterns,
    ...escapedPatterns,
    ...escapedPatterns,
  ]
    .reduce((total, pattern) => total + pattern.length, 0);
  return { raw: rawPatterns, folded: foldedPatterns, escaped: escapedPatterns, totalUnits };
}

function asciiFold(value: string): string {
  return value.length === 1 && value >= "A" && value <= "Z" ? value.toLowerCase() : value;
}

function isSecretDelimiter(char: string, quote: "\"" | "'" | null): boolean {
  return quote ? char === quote : /^[\s,;)}\]]$/u.test(char);
}

function isPathTerminator(char: string, quote: "\"" | "'" | null): boolean {
  return char === "\n" || char === "\r" || (quote !== null && char === quote);
}
