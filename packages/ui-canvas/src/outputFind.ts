export const OUTPUT_FIND_MATCH_LIMIT = 1000;

export function findOutputMatches(raw: string, query: string): { positions: number[]; capped: boolean } {
  const positions: number[] = [];
  if (query.length === 0) return { positions, capped: false };
  // Advance past each literal match; never rescan prefixes or normalize offsets.
  let start = raw.indexOf(query);
  while (start !== -1 && positions.length < OUTPUT_FIND_MATCH_LIMIT) {
    positions.push(start);
    start = raw.indexOf(query, start + query.length);
  }
  return { positions, capped: start !== -1 };
}
