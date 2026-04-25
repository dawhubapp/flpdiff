/**
 * A playlist arrangement — the timeline view in FL Studio. Each FL 25
 * project has at least one (default-named "Arrangement") and may have
 * many if the user adds them.
 *
 * Skeleton scope: id + name + count of track descriptors. Timemarkers,
 * per-track names/colors/heights, and the playlist-clip content itself
 * land in follow-up commits.
 */
/**
 * One playlist clip within an arrangement. Mirrors FL's on-disk record
 * shape as emitted inside the `0xE9` arrangement-playlist blob.
 *
 * FL 21+ uses a 60-byte record per clip; earlier FL versions used 32
 * bytes. The decoder auto-detects format by payload-size divisibility.
 */
export type Clip = {
  /** Tick position on the arrangement timeline (PPQ ticks). */
  position: number;
  /** Index into the source collection. Combined with pattern_base to pick pattern vs audio/automation clip. */
  item_index: number;
  /** Clip length in PPQ ticks. */
  length: number;
  /** Track position — stored REVERSED (track 0 = 499, track 499 = 0); consumers should un-reverse if they want FL's display ordering. */
  track_rvidx: number;
  /** Group id (0 for ungrouped). */
  group: number;
  /** Item flags bitmask. */
  item_flags: number;
  /** Clip start offset in seconds (for audio clips; ticks for pattern clips). */
  start_offset: number;
  /** Clip end offset. */
  end_offset: number;
};

/**
 * Decode arrangement clips from a `0xE9` payload. Handles both FL 21+
 * (60-byte records, "new" format) and earlier (32-byte records) layouts
 * via size-divisibility auto-detection. Returns an empty array for
 * malformed payloads.
 */
export function decodeClips(payload: Uint8Array): Clip[] {
  const recordSize = payload.byteLength % 60 === 0 ? 60 : payload.byteLength % 32 === 0 ? 32 : 0;
  if (recordSize === 0 || payload.byteLength === 0) return [];
  const out: Clip[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let p = 0; p + recordSize <= payload.byteLength; p += recordSize) {
    out.push({
      position: view.getUint32(p, true),
      // byte 4-5 pattern_base (always 20480 = 0x5000) — skipped
      item_index: view.getUint16(p + 6, true),
      length: view.getUint32(p + 8, true),
      track_rvidx: view.getUint16(p + 12, true),
      group: view.getUint16(p + 14, true),
      // bytes 16-17 reserved (_u1)
      item_flags: view.getUint16(p + 18, true),
      // bytes 20-23 reserved (_u2)
      start_offset: view.getFloat32(p + 24, true),
      end_offset: view.getFloat32(p + 28, true),
      // bytes 32-59 reserved (_u3, FL 21+ only)
    });
  }
  return out;
}

/**
 * A marker on the arrangement's timeline. Two kinds: plain text
 * markers and time-signature changes. FL encodes the kind in the
 * high bits of the `0x94` time-marker position uint32 value —
 * the `SIGNATURE_BIT` (0x08000000) flips a regular marker into a
 * time-signature marker carrying numerator + denominator.
 */
export type TimeMarkerKind = "marker" | "signature";

export type TimeMarker = {
  kind: TimeMarkerKind;
  /** Position in PPQ ticks on the arrangement timeline. */
  position: number;
  /** User-set marker name, if any (from opcode 0xCD, UTF-16LE). */
  name?: string;
  /** Time-signature numerator; only meaningful for `kind === "signature"`. */
  numerator?: number;
  /** Time-signature denominator; only meaningful for `kind === "signature"`. */
  denominator?: number;
};

const TIME_SIGNATURE_BIT = 0x08000000;

/**
 * Decode a `0x94` time-marker position uint32 into its kind + plain-ticks
 * position. The high bit `0x08000000` flags time-signature markers.
 */
export function decodeTimeMarkerPosition(raw: number): { kind: TimeMarkerKind; position: number } {
  if ((raw & TIME_SIGNATURE_BIT) !== 0) {
    return { kind: "signature", position: raw & ~TIME_SIGNATURE_BIT };
  }
  return { kind: "marker", position: raw };
}

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
  /**
   * Playlist clips on this arrangement's timeline, decoded from
   * opcode `0xE9`. FL omits the event entirely when there are no
   * clips — so an empty arrangement has `clips === []`, not undefined.
   */
  clips: Clip[];
  /**
   * Timeline markers — plain text markers and time-signature changes.
   * Empty when the user hasn't added any; FL doesn't emit default
   * markers on a fresh project.
   */
  timemarkers: TimeMarker[];
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
