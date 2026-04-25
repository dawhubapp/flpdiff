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
};

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
