import { describe, expect, it } from "vitest";

import {
  StreamingSensitiveOutputRedactor,
  type StreamingRedactorDiagnostics,
} from "./streamingSensitiveOutputRedactor.js";

describe("Hermes session announcements", () => {
  it("redacts every field, colon, and value split while retaining stream identity and whitespace", () => {
    const input = "safe\r\n \tsession_id \t: \tfresh-native-probe 	 suffix\r\nnext\n";
    const expected = input.replace("fresh-native-probe", "[redacted]");
    const markerStart = input.indexOf("fresh-native-probe");
    const sanitized = Array.from(input, (char, index) =>
      index === markerStart ? "[redacted]" :
        index > markerStart && index < markerStart + "fresh-native-probe".length ? "" : char
    );
    for (let split = 0; split <= input.length; split += 1) {
      for (const stream of ["stdout", "stderr"] as const) {
        const redactor = new StreamingSensitiveOutputRedactor([], undefined, "hermes");
        const chunks = [
          ...redactor.push("stdout", input.slice(0, split)),
          ...redactor.push(stream, input.slice(split)),
          ...redactor.flush(),
        ];
        expect(chunks).toEqual([
          ...(split ? [{ stream: "stdout", text: sanitized.slice(0, split).join("") }] : []),
          ...(split < input.length ? [{ stream, text: sanitized.slice(split).join("") }] : []),
        ]);
        expect(chunks.map((chunk) => chunk.text).join(""), `split ${split}`).toBe(expected);
      }
    }
  });

  it("handles repeated announcements in alternating one-character streams", () => {
    const input = "session_id: fresh-one\nsession_id:\tfresh-two\r\n\tsession_id : fresh-three";
    const redactor = new StreamingSensitiveOutputRedactor([], undefined, "hermes");
    const chunks = Array.from(input).flatMap((char, index) =>
      redactor.push(index % 2 ? "stderr" : "stdout", char)
    );
    chunks.push(...redactor.flush());
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input.replace(/fresh-\w+/g, "[redacted]"));
    expect(chunks.map((chunk) => chunk.stream)).toEqual(Array.from(input, (_, index) => index % 2 ? "stderr" : "stdout"));
  });

  it.each(["a", "fresh-雪-💥", "'quoted-token'", '"quoted-token"', String.raw`fresh\u1234`, "fresh,;}]/path:=token"])(
    "treats the complete first non-whitespace token %s as one value",
    (value) => {
      const redactor = new StreamingSensitiveOutputRedactor([], undefined, "hermes");
      const input = `session_id:\t${value}\u2003safe suffix\r\n`;
      const chunks = Array.from(input).flatMap((char) => redactor.push("stderr", char));
      chunks.push(...redactor.flush());
      expect(chunks.map((chunk) => chunk.text).join("")).toBe("session_id:\t[redacted]\u2003safe suffix\r\n");
    },
  );

  it("flushes every truncated prefix and empty value without releasing any value bytes", () => {
    const prefix = " \tsession_id \t: \t";
    const input = `${prefix}fresh-truncated-probe`;
    for (let length = 0; length <= input.length; length += 1) {
      const redactor = new StreamingSensitiveOutputRedactor([], undefined, "hermes");
      const chunks = [...redactor.push("stderr", input.slice(0, length)), ...redactor.flush()];
      expect(chunks.map((chunk) => chunk.text).join(""), `length ${length}`)
        .toBe(length <= prefix.length ? input.slice(0, length) : `${prefix}[redacted]`);
      expect(redactor.flush()).toEqual([]);
    }
    const redactor = new StreamingSensitiveOutputRedactor([], undefined, "hermes");
    const empty = "session_id: \t\r\nnext\nsession_id:\n";
    expect([...redactor.push("stdout", empty), ...redactor.flush()].map((chunk) => chunk.text).join(""))
      .toBe(empty);
  });

  it("leaves JSON keys, inline prose, other field spellings, and generic mode unchanged", () => {
    const negative = '{"session_id":"public-value"}\n  "session_id": "public-value"\nprose session_id: public-value\nxsession_id: public-value\nSession_id: public-value\nsession_id = public-value\nsession_id_extra: public-value\nsess\nion_id: public-value\n';
    for (const mode of [undefined, "hermes"] as const) {
      const redactor = new StreamingSensitiveOutputRedactor([], undefined, mode);
      const input = mode ? negative : `${negative}session_id: public-value\n`;
      const chunks = Array.from(input).flatMap((char) => redactor.push("stdout", char));
      chunks.push(...redactor.flush());
      expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    }
  });

  it("coexists with every existing encoded known-handle representation", () => {
    for (const representation of encodedRepresentations("opaque-雪-token")) {
      const redactor = new StreamingSensitiveOutputRedactor(["opaque-雪-token"], undefined, "hermes");
      const input = `known ${representation} after\nsession_id: fresh-probe\n`;
      const chunks = Array.from(input).flatMap((char) => redactor.push("stdout", char));
      chunks.push(...redactor.flush());
      expect(chunks.map((chunk) => chunk.text).join("")).toBe("known [redacted] after\nsession_id: [redacted]\n");
    }
  });

  it("preserves known-handle matching that overlaps an announcement field and its suffix", () => {
    for (const handle of ["session_id:known-native-probe", "known-prefix\nsession_id:known-native-probe\nknown-tail"]) {
      for (let split = 0; split <= handle.length; split += 1) {
        const redactor = new StreamingSensitiveOutputRedactor([handle], undefined, "hermes");
        const chunks = [
          ...redactor.push("stdout", handle.slice(0, split)),
          ...redactor.push("stderr", handle.slice(split)),
          ...redactor.flush(),
        ];
        expect(chunks.map((chunk) => chunk.text).join(""), `split ${split}`).toBe("[redacted]");
      }
    }
  });

  it("keeps long tokens and prefix whitespace bounded with deterministic linear counters", () => {
    const input = `${" \t".repeat(4096)}session_id${" \t".repeat(4096)}:${" \t".repeat(4096)}${"fresh-overflow-probe".repeat(8192)}\r\nnext\n`;
    const results = [false, true].map((tinyChunks) => {
      const diagnostics = makeDiagnostics();
      const redactor = new StreamingSensitiveOutputRedactor([], diagnostics, "hermes");
      const output = (tinyChunks ? Array.from(input) : [input]).flatMap((chunk, index) =>
        redactor.push(index % 2 ? "stderr" : "stdout", chunk)
      );
      output.push(...redactor.flush());
      expect(Buffer.from(output.map((chunk) => chunk.text).join("")).equals(
        Buffer.from(input.replace("fresh-overflow-probe".repeat(8192), "[redacted]")),
      )).toBe(true);
      expectLinearBound(diagnostics);
      expect(diagnostics.maxRetainedQueueChars).toBeLessThanOrEqual(128);
      expect(diagnostics.maxBlockedCarryChars).toBeLessThanOrEqual(128);
      expect(diagnostics.retainedQueueChars).toBe(0);
      expect(diagnostics.maxFrontierStates).toBeLessThanOrEqual(512);
      expect(diagnostics.boundedFrontierWork).toBeLessThanOrEqual(input.length * 8 + 2048);
      return diagnostics;
    });
    expect(results[1]!.operations).toBeGreaterThan(results[0]!.operations);
  });
});

describe("StreamingSensitiveOutputRedactor diagnostics", () => {
  it("redacts encoded sensitive values across every same-stream and alternating-stream split", () => {
    const sensitiveValues = ["opaque-token", "opaque-雪-token", "opaque-ÿ-token", "/Users/alice/private/repo"];
    for (const sensitiveValue of sensitiveValues) {
      for (const representation of encodedRepresentations(sensitiveValue)) {
        const characters = Array.from(representation);
        for (let split = 1; split < characters.length; split += 1) {
          for (const secondStream of ["stdout", "stderr"] as const) {
            const redactor = new StreamingSensitiveOutputRedactor([sensitiveValue]);
            const output = [
              ...redactor.push("stdout", `before ${characters.slice(0, split).join("")}`),
              ...redactor.push(secondStream, `${characters.slice(split).join("")} after`),
              ...redactor.flush(),
            ];

            const expected = representation === sensitiveValue && sensitiveValue.startsWith("/")
              ? "before [redacted-path]"
              : "before [redacted] after";
            expect(output.map((chunk) => chunk.text).join(""), `${representation} at ${split}`)
              .toBe(expected);
            expect(output.map((chunk) => chunk.stream)).toEqual(
              expect.arrayContaining(secondStream === "stderr" ? ["stdout", "stderr"] : ["stdout"]),
            );
          }
        }
        const alternating = new StreamingSensitiveOutputRedactor([sensitiveValue]);
        const alternatingOutput = [
          ...alternating.push("stdout", "before "),
          ...characters.flatMap((character, index) =>
            alternating.push(index % 2 === 0 ? "stdout" : "stderr", character)
          ),
          ...alternating.push("stdout", " after"),
          ...alternating.flush(),
        ];
        const expected = representation === sensitiveValue && sensitiveValue.startsWith("/")
          ? "before [redacted-path]"
          : "before [redacted] after";
        expect(alternatingOutput.map((chunk) => chunk.text).join(""), `${representation} alternating`)
          .toBe(expected);
      }
    }
  });

  it.each([
    "%6f%70%61%71%75%65%2d%74%6f%6b%65%6e",
    "6f70617175652d746f6b656e",
    "b3BhcXVlLXRva2Vu",
  ])("redacts the Review16 leak probe %s", (representation) => {
    const redactor = new StreamingSensitiveOutputRedactor(["opaque-token"]);
    const output = [
      ...redactor.push("stdout", representation.slice(0, 3)),
      ...redactor.push("stderr", representation.slice(3)),
      ...redactor.flush(),
    ];

    expect(output.map((chunk) => chunk.text).join("")).toBe("[redacted]");
  });

  it("keeps Windows forward-slash path redaction across every stream boundary", () => {
    const path = "C:/Users/alice/private/repo";
    for (let split = 1; split < path.length; split += 1) {
      const redactor = new StreamingSensitiveOutputRedactor(["unrelated-sensitive-value"]);
      const output = [
        ...redactor.push("stdout", path.slice(0, split)),
        ...redactor.push("stderr", path.slice(split)),
        ...redactor.flush(),
      ];
      expect(output.map((chunk) => chunk.text).join(""), `split ${split}`)
        .toBe("[redacted-path]");
    }
  });

  it.each([
    ["POSIX spaces", "cwd=/Users/alice/Stealth Roadmap/output.png\nnext=public\n", "cwd=[redacted-path]\nnext=public\n"],
    ["Windows slash spaces", "repo=C:/Users/alice/Acquisition Target/results.json\r\nnext=public\r\n", "repo=[redacted-path]\r\nnext=public\r\n"],
    ["Windows backslash spaces", "repo=C:\\Users\\alice\\Acquisition Target\\results.json\nnext=public\n", "repo=[redacted-path]\nnext=public\n"],
    ["quoted punctuation", "cwd=\"/Users/alice/Plan, draft; [private]/output.png\" next=public\n", "cwd=\"[redacted-path]\" next=public\n"],
    ["quoted Windows punctuation", "repo='C:\\Users\\alice\\Plan, draft; [private]\\results.json' next=public\n", "repo='[redacted-path]' next=public\n"],
    ["Unicode spaces", "cwd=/Users/alice/Stealth\u2003Roadmap/output.png same-line prose\nnext=public\n", "cwd=[redacted-path]\nnext=public\n"],
  ])("redacts the complete %s path across every chunk and alternating stream boundary", (_name, input, expected) => {
    const characters = Array.from(input);
    for (let split = 1; split < characters.length; split += 1) {
      const redactor = new StreamingSensitiveOutputRedactor(["unrelated-sensitive-value"]);
      const output = [
        ...redactor.push("stdout", characters.slice(0, split).join("")),
        ...redactor.push("stderr", characters.slice(split).join("")),
        ...redactor.flush(),
      ];
      expect(output.map((chunk) => chunk.text).join(""), `split ${split}`).toBe(expected);
      expect(output.map((chunk) => chunk.text).join("").match(/\[redacted-path\]/g)).toHaveLength(1);
    }

    const alternating = new StreamingSensitiveOutputRedactor(["unrelated-sensitive-value"]);
    const alternatingOutput = characters.flatMap((character, index) =>
      alternating.push(index % 2 === 0 ? "stdout" : "stderr", character)
    );
    alternatingOutput.push(...alternating.flush());
    expect(alternatingOutput.map((chunk) => chunk.text).join("")).toBe(expected);
    expect(alternatingOutput.map((chunk) => chunk.text).join("").match(/\[redacted-path\]/g)).toHaveLength(1);
  });

  it("keeps a large spaced path line fail-closed with bounded carry and linear work", () => {
    const privateLine = `/Users/alice/${"Stealth Roadmap ".repeat(65_536)}output.png`;
    const input = `cwd=${privateLine}\nnext=public\n`;
    const result = redactWithDiagnostics(Array.from(input));

    expect(result.output).toBe("cwd=[redacted-path]\nnext=public\n");
    expect(result.output.match(/\[redacted-path\]/g)).toHaveLength(1);
    expectLinearBound(result.diagnostics);
    expect(result.diagnostics.maxRetainedQueueChars).toBeLessThanOrEqual(128);
    expect(result.diagnostics.maxBlockedCarryChars).toBeLessThanOrEqual(128);
  }, 60_000);

  it("accounts for O(chars + chunks + boundedFrontierWork) including every chunk envelope", () => {
    const ordinary = "x".repeat(65_536);
    const oneChunk = redactWithDiagnostics([ordinary]);
    const tinyChunks = redactWithDiagnostics(Array.from({ length: ordinary.length / 8 }, (_, index) =>
      ordinary.slice(index * 8, index * 8 + 8)
    ));

    expect(oneChunk.output).toBe(ordinary);
    expect(tinyChunks.output).toBe(ordinary);
    expect(oneChunk.diagnostics.inputChars).toBe(ordinary.length);
    expect(oneChunk.diagnostics.chunks).toBe(1);
    expect(tinyChunks.diagnostics.inputChars).toBe(ordinary.length);
    expect(tinyChunks.diagnostics.chunks).toBe(8_192);
    expect(tinyChunks.diagnostics.operations).toBeGreaterThan(oneChunk.diagnostics.operations + 8_000);
    expect(oneChunk.diagnostics.boundedFrontierWork).toBeLessThanOrEqual(ordinary.length * 8 + 2_048);
    expectLinearBound(oneChunk.diagnostics);
    expectLinearBound(tinyChunks.diagnostics);
  });

  it.each([65_536, 1_048_576])("keeps %i ordinary characters exact with bounded retained state", (length) => {
    const input = "y".repeat(length);
    const result = redactWithDiagnostics([input]);

    expect(Buffer.from(result.output, "utf8").equals(Buffer.from(input, "utf8"))).toBe(true);
    expect(result.diagnostics.boundedFrontierWork).toBeLessThanOrEqual(length * 8 + 2_048);
    expectLinearBound(result.diagnostics);
    expect(result.diagnostics.retainedQueueChars).toBe(0);
    expect(result.diagnostics.blockedCarryChars).toBe(0);
    expect(result.diagnostics.maxRetainedQueueChars).toBeLessThanOrEqual(128);
    expect(result.diagnostics.maxBlockedCarryChars).toBeLessThanOrEqual(128);
    expect(result.diagnostics.maxFrontierStates).toBeLessThanOrEqual(512);
  }, 60_000);

  it.each([
    ["space", " "],
    ["sensitive first character", "u"],
    ["percent marker", "%"],
    ["hex alphabet", "6"],
    ["base64 alphabet", "b"],
    ["ordinary Unicode", "雪"],
  ])("keeps 1 MiB of %s exact below the low-constant operation bound", (_name, character) => {
    const byteLength = 1_048_576;
    const count = Math.floor(byteLength / Buffer.byteLength(character, "utf8"));
    const input = character.repeat(count);
    const result = redactWithDiagnostics([input]);

    expect(result.output).toBe(input);
    expect(result.diagnostics.operations).toBeLessThanOrEqual(
      result.diagnostics.inputChars * 64 + result.diagnostics.chunks * 16 + 4_096,
    );
    expect(result.diagnostics.retainedQueueChars).toBe(0);
    expect(result.diagnostics.maxRetainedQueueChars).toBeLessThanOrEqual(128);
    expect(result.diagnostics.maxBlockedCarryChars).toBeLessThanOrEqual(128);
  }, 120_000);

  it("keeps thousands of tiny alternating-stream chunks linear and globally ordered", () => {
    const diagnostics = makeDiagnostics();
    const redactor = new StreamingSensitiveOutputRedactor(["opaque-token"], diagnostics);
    const chunks = Array.from({ length: 12_000 }, (_, index) => ({
      stream: index % 2 === 0 ? "stdout" as const : "stderr" as const,
      text: index % 3 === 0 ? "x" : " ",
    }));
    const output = chunks.flatMap((chunk) => redactor.push(chunk.stream, chunk.text));
    output.push(...redactor.flush());

    expect(output.map((chunk) => chunk.text).join("")).toBe(chunks.map((chunk) => chunk.text).join(""));
    expect(diagnostics.chunks).toBe(chunks.length);
    expect(diagnostics.operations).toBeLessThanOrEqual(
      diagnostics.inputChars * 64 + diagnostics.chunks * 16 + 4_096,
    );
    expect(diagnostics.maxRetainedQueueChars).toBeLessThanOrEqual(128);
  });

  it("keeps adversarial carry exact and bounded without queue rescans", () => {
    const sensitiveValue = `${"a".repeat(512)}-capability`;
    const input = `${"a".repeat(127)}b`.repeat(512);
    const diagnostics = makeDiagnostics();
    const redactor = new StreamingSensitiveOutputRedactor([sensitiveValue], diagnostics);
    const chunks = [
      ...redactor.push("stdout", input),
      ...redactor.flush(),
    ];

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expectLinearBound(diagnostics);
    expect(diagnostics.maxRetainedQueueChars).toBeLessThanOrEqual(128);
    expect(diagnostics.maxBlockedCarryChars).toBeLessThanOrEqual(128);
    expect(diagnostics.maxFrontierStates).toBeLessThanOrEqual(512);
  }, 60_000);
});

function encodedRepresentations(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const percentLower = [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const hexLower = bytes.toString("hex");
  const base64 = bytes.toString("base64");
  const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_");
  const mixedCase = (encoded: string) => Array.from(encoded).map((character, index) =>
    index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()
  ).join("");
  const escapedBytes = [...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return [...new Set([
    value,
    percentLower,
    encodeURIComponent(value),
    percentLower.toUpperCase(),
    mixedCase(percentLower),
    hexLower,
    hexLower.toUpperCase(),
    mixedCase(hexLower),
    base64,
    base64.replace(/=+$/, ""),
    base64url,
    base64url.replace(/=+$/, ""),
    jsonEscaped,
    escapedBytes,
    mixedCase(escapedBytes),
  ])];
}

function redactWithDiagnostics(chunks: string[]): {
  output: string;
  diagnostics: StreamingRedactorDiagnostics;
} {
  const diagnostics = makeDiagnostics();
  const redactor = new StreamingSensitiveOutputRedactor(["unrelated-sensitive-capability"], diagnostics);
  const output = chunks.flatMap((chunk) => redactor.push("stdout", chunk));
  output.push(...redactor.flush());
  return { output: output.map((chunk) => chunk.text).join(""), diagnostics };
}

function expectLinearBound(diagnostics: StreamingRedactorDiagnostics): void {
  expect(diagnostics.operations).toBeLessThanOrEqual(
    diagnostics.inputChars * 32 + diagnostics.chunks * 16 + diagnostics.boundedFrontierWork * 2 + 2_048,
  );
}

function makeDiagnostics(): StreamingRedactorDiagnostics {
  return {
    operations: 0,
    inputChars: 0,
    chunks: 0,
    boundedFrontierWork: 0,
    retainedQueueChars: 0,
    maxRetainedQueueChars: 0,
    blockedCarryChars: 0,
    maxBlockedCarryChars: 0,
    frontierStates: 0,
    maxFrontierStates: 0,
  };
}
