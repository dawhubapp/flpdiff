/**
 * A pattern from the pattern-rack. At this skeleton level we carry the
 * FL-assigned pattern id and optional user-set name; notes, controllers,
 * length, color, and loop state all follow in subsequent commits.
 *
 * Pattern ids are NOT guaranteed contiguous — users can delete a middle
 * pattern, leaving gaps (e.g., `[0, 2, 3]`). We preserve the raw id
 * rather than remapping.
 */
export type Pattern = {
  /** FL-assigned pattern id from opcode `0x41` (pattern identity marker) value. */
  id: number;
  /** User-set pattern name, from opcode `0xC1`. */
  name?: string;
};

/**
 * Human-readable summary matching `flp-info`'s `Patterns: N` convention.
 */
export function formatPatternSummary(patterns: readonly Pattern[]): string {
  const n = patterns.length;
  return n === 0 ? "0 patterns" : n === 1 ? "1 pattern" : `${n} patterns`;
}
