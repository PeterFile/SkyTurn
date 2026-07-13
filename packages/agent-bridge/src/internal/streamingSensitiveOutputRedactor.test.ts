import { describe, expect, it } from "vitest";

import {
  StreamingSensitiveOutputRedactor,
  type StreamingRedactorDiagnostics,
} from "./streamingSensitiveOutputRedactor.js";

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
