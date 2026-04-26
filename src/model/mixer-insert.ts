/**
 * One effect slot on a mixer insert. FL always writes 10 slots per
 * insert regardless of whether they hold a plugin.
 */
export type MixerSlot = {
  /** Slot index within its parent insert (0..9 on FL 25). */
  index: number;
  /**
   * Display name of the plugin loaded in this slot, if any. Sourced
   * from opcode `0xCB` in slot scope (after a `0x62` slot boundary).
   * Empty slots leave `pluginName === undefined`.
   */
  pluginName?: string;
  /**
   * True when a plugin state event (`0xD5`) appeared in this slot's
   * scope. Plugin presence is keyed off the `0xD5` data event, not
   * off the plugin name. Some slots have `0xD5` without a user-set
   * `0xCB` name (e.g., natively-hosted plugins whose state blob was
   * saved without a display name); those still count as "filled".
   */
  hasPlugin?: boolean;
  /**
   * Plugin internal name — `0xC9` in slot scope. For VSTs this is
   * `"Fruity Wrapper"`; for natives it's the display name (same as
   * `pluginName` typically). When `internalName === "Fruity Wrapper"`,
   * the `0xD5` state blob carries the VST's real name / vendor /
   * path in the FL wrapper record stream (decoded into
   * `pluginVstName` / `pluginVendor`).
   */
  internalName?: string;
  /** Real VST display name extracted from the 0xD5 wrapper blob (id=54). */
  pluginVstName?: string;
  /** Real VST vendor extracted from the 0xD5 wrapper blob (id=56). */
  pluginVendor?: string;
  /**
   * Per-slot enabled flag from `0xE1` MixerParams records with `id
   * = 0` (SlotEnabled). Python defaults to `true` when the record
   * isn't present; we match.
   */
  enabled?: boolean;
  /**
   * Per-slot dry/wet mix from `0xE1` MixerParams records with `id
   * = 1` (SlotMix). Raw int (`-6400..6400`), presentation layer
   * normalises to Python's float space.
   */
  mix?: number;
};

/**
 * Insert-level bitmask flags, decoded from the uint32 at byte offset 4
 * of the `0xEC` insert-flags blob. (FL 25 relocated this opcode from
 * the pre-FL-25 `0xDC` to `0xEC`, matching the general FL 25 "DATA
 * range +16" relocation pattern.)
 *
 * FL 25's default inserts report `enableEffects + enabled` (= 0x0C);
 * numbered inserts additionally set `dockMiddle` (→ 0x4C).
 */
export type InsertFlags = {
  polarityReversed: boolean;
  swapLeftRight: boolean;
  enableEffects: boolean;
  enabled: boolean;
  disableThreadedProcessing: boolean;
  dockMiddle: boolean;
  dockRight: boolean;
  separatorShown: boolean;
  locked: boolean;
  solo: boolean;
  /** True when the insert is linked to an audio track. */
  audioTrack: boolean;
};

/**
 * One record inside the `0xE1` MixerParams blob — a 12-byte entry
 * describing a single per-insert or per-slot parameter value.
 *
 * Layout (verified against direct byte inspection of `base_empty.flp`'s
 * 6924-byte payload, 577 records):
 *
 *   0..3   reserved
 *   4      id (uint8) — known values:
 *            0   = SlotEnabled
 *            1   = SlotMix
 *            64..191 = RouteVolStart (send-level routing)
 *            192 = Volume
 *            193 = Pan
 *            194 = StereoSeparation
 *            208/209/210 = Low/Mid/High Gain
 *            216/217/218 = Low/Mid/High Freq
 *            224/225/226 = Low/Mid/High Q
 *   5      reserved
 *   6..7   channel_data (uint16 LE): (insert_idx << 6) | slot_idx
 *   8..11  msg (int32 LE) — parameter value
 *
 * **Attribution**: `decodeMixerParams(payload)` returns raw records;
 * `buildMixerInserts` walks them and writes `MixerInsert.{pan,volume,
 * stereoSeparation}` and `MixerSlot.{enabled,mix}` keyed by the
 * unpacked `(insertIdx, slotIdx)` pair. Records whose `insertIdx`
 * falls outside `[0, inserts.length)` are silently dropped — FL emits
 * records for pre-allocated insert slots (indices like 53, 64..80)
 * that aren't surfaced via the 0x93 insert-begin marker; those stay
 * latent rather than creating phantom inserts.
 */
export type MixerParamRecord = {
  id: number;
  insertIdx: number;
  slotIdx: number;
  msg: number;
};

export function decodeMixerParams(payload: Uint8Array): MixerParamRecord[] {
  const out: MixerParamRecord[] = [];
  if (payload.byteLength % 12 !== 0) return out;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let p = 0; p + 12 <= payload.byteLength; p += 12) {
    const id = view.getUint8(p + 4);
    const cd = view.getUint16(p + 6, true);
    const msg = view.getInt32(p + 8, true);
    out.push({ id, insertIdx: (cd >> 6) & 0x7f, slotIdx: cd & 0x3f, msg });
  }
  return out;
}

/**
 * Decode the project-level insert-routing payload at opcode `0xE7`.
 * The payload is a dense byte array where each byte is a bool flag:
 * position `i` is `true` ⇔ this insert sends audio to insert index
 * `i`. FL writes one flag per insert *position* in the mixer including
 * the master and latent slots, so the array length equals FL's
 * internal `max_inserts + 1` (typically 127 on FL 25 projects even
 * though only ~18 are visible).
 *
 * We return a plain `boolean[]` preserving FL's byte order; callers
 * can derive the subset of "real" target indices by intersecting
 * with the visible `inserts` range.
 */
export function decodeInsertRouting(payload: Uint8Array): boolean[] {
  const out: boolean[] = new Array(payload.byteLength);
  for (let i = 0; i < payload.byteLength; i++) out[i] = payload[i] !== 0;
  return out;
}

export function decodeInsertFlags(payload: Uint8Array): InsertFlags | undefined {
  if (payload.byteLength < 12) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const raw = view.getUint32(4, true);
  return {
    polarityReversed: (raw & (1 << 0)) !== 0,
    swapLeftRight: (raw & (1 << 1)) !== 0,
    enableEffects: (raw & (1 << 2)) !== 0,
    enabled: (raw & (1 << 3)) !== 0,
    disableThreadedProcessing: (raw & (1 << 4)) !== 0,
    dockMiddle: (raw & (1 << 6)) !== 0,
    dockRight: (raw & (1 << 7)) !== 0,
    separatorShown: (raw & (1 << 10)) !== 0,
    locked: (raw & (1 << 11)) !== 0,
    solo: (raw & (1 << 12)) !== 0,
    audioTrack: (raw & (1 << 15)) !== 0,
  };
}

/**
 * A mixer insert (also called an "FX channel"). FL 25 projects always
 * have a fixed number of inserts — 18 active ones on a freshly-saved
 * base project (1 master + 17 numbered inserts), plus a large tail of
 * latent inserts the parser doesn't currently surface.
 *
 * Scope of the v0.1 skeleton: index, name, and effect slots (with plugin
 * names). Routing, volume, pan, color are separate opcodes that will
 * land in follow-up commits under Phase 3.3.3.
 */
export type MixerInsert = {
  /**
   * Zero-based insert index. Index 0 is the master insert. FL's UI
   * renders the first numbered insert as "Insert 1"; we use the
   * underlying 0-based index to match Python's JSON output.
   */
  index: number;
  /**
   * User-assigned insert name, if any. Unnamed inserts (including the
   * master unless the user explicitly renamed it) have `name === undefined`.
   * Sourced from opcode `0xCC` (UTF-16LE null-terminated).
   */
  name?: string;
  /**
   * Insert color (RGBA). Sourced from opcode `0x95` (uint32 LE with
   * bytes in `[R, G, B, A]` order — same packing as `0x80`). FL only
   * emits this event when the user explicitly sets a custom color;
   * default-colored inserts leave the field undefined.
   */
  color?: { r: number; g: number; b: number; a: number };
  /**
   * Insert icon id. Sourced from opcode `0x5F` (int16 LE). Absent
   * when the user hasn't picked an explicit icon.
   */
  icon?: number;
  /**
   * Output routing target — the mixer-insert index this insert feeds
   * into. Sourced from the `0x93` event's payload (int32 LE).
   * `undefined` when FL emits `-1` (= 0xFFFFFFFF, the "unrouted /
   * default master" sentinel).
   */
  output?: number;
  /**
   * Audio-input source. Sourced from `0x9A` (int32 LE). `undefined`
   * when FL emits the `-1` sentinel.
   */
  input?: number;
  /**
   * Insert-level bitmask flags (bypass / swap / enabled / docking / etc.).
   * Sourced from the 12-byte `0xEC` insert-flags blob. Present on
   * every insert in FL 25's default save output.
   */
  flags?: InsertFlags;
  /**
   * Insert-level MixerParams values, sourced from records in the
   * project-level `0xE1` blob with `channel_data = (insertIdx << 6) |
   * slotIdx`. When the `id` byte matches one of the catalogued
   * MixerParams IDs, the 32-bit signed `msg` lands here as a raw int.
   * Presentation layer normalises to Python's float space (pan / 6400,
   * volume / 12800).
   *
   * `pan`: id 193, raw `-6400..6400` (centre 0).
   * `volume`: id 192, raw `0..12800` (default 0).
   * `stereoSeparation`: id 194 — same range as pan.
   */
  pan?: number;
  volume?: number;
  stereoSeparation?: number;
  /**
   * Effect slots on this insert, in declaration order. FL 25 always
   * emits 10 slots per insert; empty slots have `pluginName === undefined`.
   */
  slots: MixerSlot[];
};

/**
 * Count of inserts that carry a user-assigned name. The master is
 * unnamed by default so a fresh project reports 0 here.
 */
export function countNamedInserts(inserts: readonly MixerInsert[]): number {
  return inserts.reduce((n, ins) => n + (ins.name !== undefined ? 1 : 0), 0);
}

/**
 * Count of mixer slots currently hosting a plugin (across all inserts).
 */
export function countActiveSlots(inserts: readonly MixerInsert[]): number {
  return inserts.reduce(
    (n, ins) => n + ins.slots.reduce((m, s) => m + (s.pluginName !== undefined ? 1 : 0), 0),
    0,
  );
}

/**
 * "18 active inserts, 1 named" — mirrors the shape of Python's
 * `flp-info` mixer summary line so CLI output can stay oracle-comparable.
 */
export function formatMixerSummary(inserts: readonly MixerInsert[]): string {
  const total = inserts.length;
  const named = countNamedInserts(inserts);
  const active = countActiveSlots(inserts);
  const parts: string[] = [`${total} active inserts`];
  if (named > 0) parts.push(`${named} named`);
  if (active > 0) parts.push(`${active} effect ${active === 1 ? "slot" : "slots"}`);
  return parts.join(", ");
}
