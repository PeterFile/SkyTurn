import { describe, expect, it } from "vitest";
import { findOutputMatches, OUTPUT_FIND_MATCH_LIMIT } from "./outputFind.js";

describe("captured output literal find", () => {
  it("finds across exact fragments without adding separators", () => {
    expect(findOutputMatches(["split", "", "word\r", "\n\t  splitword"].join(""), "splitword"))
      .toEqual({ positions: [0, 14], capped: false });
  });

  it("treats metacharacters literally and case sensitively without folding Unicode offsets", () => {
    const raw = "İ [a.*]+? [A.*]+? 🙂[a.*]+?";
    expect(findOutputMatches(raw, "[a.*]+?")).toEqual({ positions: [2, 20], capped: false });
    expect(findOutputMatches(raw, "[A.*]+?").positions).toEqual([10]);
    expect(findOutputMatches("İiI", "i").positions).toEqual([1]);
  });

  it("keeps whitespace and CRLF literal, and distinguishes empty from no matches", () => {
    const raw = " \t\r\n  \r\n";
    expect(findOutputMatches(raw, "")).toEqual({ positions: [], capped: false });
    expect(findOutputMatches(raw, " ").positions).toEqual([0, 4, 5]);
    expect(findOutputMatches(raw, "\r\n").positions).toEqual([2, 6]);
    expect(findOutputMatches(raw, "\n ").positions).toEqual([3]);
    expect(findOutputMatches(raw, "missing")).toEqual({ positions: [], capped: false });
    expect(findOutputMatches("", " ")).toEqual({ positions: [], capped: false });
  });

  it("uses ordered non-overlapping matches", () => {
    expect(findOutputMatches("aaaaa", "aa")).toEqual({ positions: [0, 2], capped: false });
  });

  it("bounds retained positions and only reports a cap when more matches exist", () => {
    const exact = findOutputMatches("x".repeat(OUTPUT_FIND_MATCH_LIMIT), "x");
    expect(exact.positions).toHaveLength(OUTPUT_FIND_MATCH_LIMIT);
    expect(exact.capped).toBe(false);
    const large = findOutputMatches("x".repeat(2_000_000), "x");
    expect(large.positions).toHaveLength(OUTPUT_FIND_MATCH_LIMIT);
    expect(large.positions.at(-1)).toBe(OUTPUT_FIND_MATCH_LIMIT - 1);
    expect(large.capped).toBe(true);
  });

  it("handles a long near-miss literal without regex backtracking", () => {
    expect(findOutputMatches("a".repeat(200_000), "a".repeat(20_000) + "b"))
      .toEqual({ positions: [], capped: false });
  });
});
