/**
 * Project metadata decoded from project-level events in the envelope
 * before channels/patterns/mixer. Only the fields actually emitted
 * by our corpus are populated so far — the rest land as we hit
 * their opcodes.
 */
export type ProjectMetadata = {
  /** User-set project title. Opcode `0xC2`. */
  title?: string;
  /** Project creation timestamp. Opcode `0xED`. */
  createdOn?: Date;
  /**
   * Total time the user has spent editing this project (across all
   * sessions). Stored in the same 16-byte Timestamp payload as
   * `createdOn` — the second float64 holds the duration in days.
   */
  timeSpent?: { seconds: number };
};

/**
 * FL saves `Timestamp` as two float64 LE values (16 bytes total).
 * First float = days since the **Delphi epoch** (1899-12-30),
 * carrying the project's creation date. Second float = total hours
 * the user has spent in the project, encoded as days.
 *
 * Python's `flp-info` renders these as:
 *   - `created_on.iso`: local datetime ISO string
 *   - `time_spent.seconds`: total seconds
 */
const DELPHI_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function decodeTimestamp(
  payload: Uint8Array,
): { createdOn: Date; timeSpent: { seconds: number } } | undefined {
  if (payload.byteLength < 16) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const createdDays = view.getFloat64(0, true);
  const spentDays = view.getFloat64(8, true);
  return {
    createdOn: new Date(DELPHI_EPOCH_MS + createdDays * MS_PER_DAY),
    timeSpent: { seconds: spentDays * 86_400 },
  };
}
