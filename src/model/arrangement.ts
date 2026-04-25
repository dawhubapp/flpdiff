/**
 * A playlist arrangement — the timeline view in FL Studio. Each FL 25
 * project has at least one (default-named "Arrangement") and may have
 * many if the user adds them.
 *
 * Skeleton scope: id + name + count of track descriptors. Timemarkers,
 * per-track names/colors/heights, and the playlist-clip content itself
 * land in follow-up commits.
 */
export type Arrangement = {
  /** FL-assigned arrangement id from opcode `0x63`. */
  id: number;
  /** User-assigned arrangement name, from opcode `0xF1`. Defaults to `"Arrangement"` on fresh FL 25 projects. */
  name?: string;
  /**
   * Count of per-track data descriptors (opcode `0xEE`) that belong to
   * this arrangement. FL 25 emits 500 track slots by default, each
   * carrying a 70-byte data blob, regardless of whether any clips
   * exist on them.
   */
  trackCount: number;
};

/**
 * Human-readable summary matching Python's flp-info format:
 *   "1 arrangement (500 tracks)"
 *   "2 arrangements (500 + 500 tracks)"
 */
export function formatArrangementSummary(arrangements: readonly Arrangement[]): string {
  const n = arrangements.length;
  if (n === 0) return "0 arrangements";
  const tracksPart = arrangements.map((a) => String(a.trackCount)).join(" + ");
  const suffix = n === 1 ? `${tracksPart} tracks` : `${tracksPart} tracks`;
  const word = n === 1 ? "arrangement" : "arrangements";
  return `${n} ${word} (${suffix})`;
}
