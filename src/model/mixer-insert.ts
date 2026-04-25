/**
 * A mixer insert (also called an "FX channel"). FL 25 projects always
 * have a fixed number of inserts — 18 active ones on a freshly-saved
 * base project (1 master + 17 numbered inserts), plus a large tail of
 * latent inserts the parser doesn't currently surface.
 *
 * Scope of the v0.1 skeleton: just {index, name}. Routing, volume, pan,
 * color, effect slots, and plugin chains are separate opcodes that will
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
};

/**
 * Count of inserts that carry a user-assigned name. The master is
 * unnamed by default so a fresh project reports 0 here.
 */
export function countNamedInserts(inserts: readonly MixerInsert[]): number {
  return inserts.reduce((n, ins) => n + (ins.name !== undefined ? 1 : 0), 0);
}

/**
 * "18 active inserts, 1 named" — mirrors the shape of Python's
 * `flp-info` mixer summary line so CLI output can stay oracle-comparable.
 */
export function formatMixerSummary(inserts: readonly MixerInsert[]): string {
  const total = inserts.length;
  const named = countNamedInserts(inserts);
  return named === 0 ? `${total} active inserts` : `${total} active inserts, ${named} named`;
}
