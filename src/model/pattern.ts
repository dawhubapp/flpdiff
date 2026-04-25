/**
 * A single note within a pattern. Mirrors FL's on-disk record shape
 * (24 bytes per note in the pattern-notes blob at opcode `0xE0`).
 */
export type Note = {
  /** Tick position within the pattern (PPQ ticks — divide by `project.header.ppq` for beats). */
  position: number;
  /** Raw flags bitmask (stemma / slide / etc. — not interpreted here). */
  flags: number;
  /** Channel iid this note triggers. Cross-referenced with `Channel.iid`. */
  channel_iid: number;
  /** Length in PPQ ticks. */
  length: number;
  /** MIDI-like key value. Middle C is 60; C3 key is 48 per FL's numbering. */
  key: number;
  /** Group id for chord/slide grouping (0 for ungrouped). */
  group: number;
  /** Micro-tuning, 0-240 with 120 being "no shift". */
  fine_pitch: number;
  /** Envelope release tweak, 0-128 with 64 being neutral. */
  release: number;
  /** MIDI channel override (0 for default). */
  midi_channel: number;
  /** Pan at the note level, 0-128 with 64 being center. */
  pan: number;
  /** Note velocity, 0-127. */
  velocity: number;
  /** Mod-X articulation control, 0-255. */
  mod_x: number;
  /** Mod-Y articulation control, 0-255. */
  mod_y: number;
};

/**
 * A pattern from the pattern-rack. Carries the FL-assigned pattern id,
 * optional user-set name, and the list of notes placed on it. Other
 * per-pattern properties (controllers, length, color, loop state) are
 * not yet surfaced.
 *
 * Pattern ids are NOT guaranteed contiguous — users can delete a middle
 * pattern, leaving gaps (e.g., `[0, 2, 3]`). We preserve the raw id
 * rather than remapping.
 */
/**
 * A keyframe-automation controller event within a pattern. Targets a
 * specific channel and produces a time-varying parameter value.
 *
 * 12-byte records carried under opcode `0xDF`.
 */
export type Controller = {
  position: number;
  channel: number;
  flags: number;
  value: number;
};

export function decodeControllers(payload: Uint8Array): Controller[] {
  const out: Controller[] = [];
  if (payload.byteLength === 0 || payload.byteLength % 12 !== 0) return out;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let p = 0; p + 12 <= payload.byteLength; p += 12) {
    out.push({
      position: view.getUint32(p, true),
      // bytes 4-5 reserved
      channel: view.getUint8(p + 6),
      flags: view.getUint8(p + 7),
      value: view.getFloat32(p + 8, true),
    });
  }
  return out;
}

export type Pattern = {
  /** FL-assigned pattern id from opcode `0x41` (pattern identity marker) value. */
  id: number;
  /** User-set pattern name, from opcode `0xC1`. */
  name?: string;
  /**
   * Pattern length in PPQ ticks, from opcode `0xA4`.
   * Value `0` means "use the project's default bar length" — FL omits
   * an explicit length for unmodified patterns and Python flp-info
   * also reports `0` in that case.
   */
  length?: number;
  /**
   * Pattern color, from opcode `0x96` (uint32 LE with bytes in
   * `[R, G, B, A]` order — same packing as channel color). Absent
   * if FL hasn't emitted an explicit color event (colors show up
   * only once a user has touched them on this pattern).
   */
  color?: { r: number; g: number; b: number; a: number };
  /**
   * `true` only when FL emitted a `0x1A` (pattern looped flag, bool)
   * event with value=1 on this pattern. Patterns default to
   * non-looped, and the opcode is simply absent in that case.
   */
  looped?: boolean;
  /** Notes placed on the pattern, in stream order. Empty for patterns with no notes yet. */
  notes: Note[];
  /**
   * Keyframe-automation controller events on this pattern. Empty on
   * every current FL 25 fixture — no committed fixture emits pattern
   * controllers. Awaiting a clip-bearing fixture to activate the
   * end-to-end walker path.
   */
  controllers: Controller[];
};

/**
 * Parse the payload of opcode `0xE0` (FL 25's pattern notes; pre-FL-25
 * saves emit notes at `0xD0`). Payload is a dense array of 24-byte records.
 */
export function decodeNotes(payload: Uint8Array): Note[] {
  const out: Note[] = [];
  if (payload.byteLength % 24 !== 0) return out;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let p = 0; p + 24 <= payload.byteLength; p += 24) {
    out.push({
      position: view.getUint32(p, true),
      flags: view.getUint16(p + 4, true),
      channel_iid: view.getUint16(p + 6, true),
      length: view.getUint32(p + 8, true),
      key: view.getUint16(p + 12, true),
      group: view.getUint16(p + 14, true),
      fine_pitch: view.getUint8(p + 16),
      // byte 17 reserved
      release: view.getUint8(p + 18),
      midi_channel: view.getUint8(p + 19),
      pan: view.getUint8(p + 20),
      velocity: view.getUint8(p + 21),
      mod_x: view.getUint8(p + 22),
      mod_y: view.getUint8(p + 23),
    });
  }
  return out;
}

/**
 * Human-readable summary matching `flp-info`'s `Patterns: N` convention.
 */
export function formatPatternSummary(patterns: readonly Pattern[]): string {
  const n = patterns.length;
  return n === 0 ? "0 patterns" : n === 1 ? "1 pattern" : `${n} patterns`;
}
