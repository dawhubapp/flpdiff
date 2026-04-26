/**
 * Mixer insert + slot diff. Ports `flp_diff.comparator.compare_mixer_insert`
 * and `_compare_slots`. Scalar-only in this first wave — opaque plugin-state
 * deltas are stubbed until Phase 3.4.2e-iii (plugin-state registry, not yet
 * in scope on the TS side).
 *
 * Slots are index-matched (0..9 per insert in FL 25). Plugin identity
 * changes route through the shared `comparePlugin` primitive that lives
 * on the channel comparator, with a `slotHint` so a 10-slot Master with
 * four plugin swaps doesn't collapse into four indistinguishable lines.
 */

import { pairByKey, type Match } from "./matcher.ts";
import {
  makeChange,
  makeMixerInsertDiff,
  makeMixerDiff,
  type Change,
  type MixerInsertDiff,
  type MixerDiff,
} from "./diff-model.ts";
import {
  classify,
  fmtBool,
  fmtNoneFriendly,
  fmtPan,
  fmtPct,
  colorHex,
  scalarChange,
  comparePluginLabels,
} from "./comparator.ts";
import type { FlpInfoJson } from "../presentation/flp-info.ts";

type InsertJson = FlpInfoJson["mixer"]["inserts"][number];
type SlotJson = InsertJson["slots"][number];

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Insert label: "Master (unnamed)" for index 0, "Insert N (name)" otherwise. */
function insertLabel(ins: InsertJson): string {
  const name = ins.name ?? "unnamed";
  if (ins.index === 0) return `Master (${name})`;
  return `Insert ${ins.index} (${name})`;
}

/**
 * Per-slot diff. Slots are index-matched (0..9 per insert). Returns
 * scalar Changes only in this commit — plugin-state opaque-change
 * plumbing lands in a follow-up when the plugin-state registry is
 * ported.
 */
export function compareSlots(
  pathPrefix: string,
  oldSlots: readonly SlotJson[],
  newSlots: readonly SlotJson[],
): Change[] {
  const out: Change[] = [];
  const maxLen = Math.max(oldSlots.length, newSlots.length);
  for (let i = 0; i < maxLen; i++) {
    const oldS: SlotJson | null = i < oldSlots.length ? oldSlots[i]! : null;
    const newS: SlotJson | null = i < newSlots.length ? newSlots[i]! : null;
    if (deepEqual(oldS, newS)) continue;
    const slotPath = `${pathPrefix}[${i}]`;

    if (oldS === null || newS === null) {
      out.push(
        makeChange({
          path: slotPath,
          kind: classify(oldS, newS),
          oldValue: oldS,
          newValue: newS,
          humanLabel: `Slot ${i} ${oldS === null ? "added" : "removed"}`,
        }),
      );
      continue;
    }

    if (oldS.enabled !== newS.enabled) {
      out.push(
        makeChange({
          path: `${slotPath}.enabled`,
          kind: "modified",
          oldValue: oldS.enabled,
          newValue: newS.enabled,
          humanLabel: `Slot ${i} ${newS.enabled ? "enabled" : "bypassed"}`,
        }),
      );
    }

    const pluginChanges = comparePluginLabels(
      `${slotPath}.plugin`,
      oldS.plugin,
      newS.plugin,
      ` in slot ${i}`,
    );
    out.push(...pluginChanges);
  }
  return out;
}

/**
 * Produce a `MixerInsertDiff` for one matched (or unmatched) pair.
 * Scalar properties only — opaque plugin-state flows through a future
 * commit.
 */
export function compareMixerInsert(match: Match<InsertJson>): MixerInsertDiff {
  if (match.old === null && match.new !== null) {
    return makeMixerInsertDiff({
      identity: ["insert", match.new.index],
      kind: "added",
      index: match.new.index,
      name: match.new.name,
      humanLabel: `Added ${insertLabel(match.new)}`,
    });
  }
  if (match.old !== null && match.new === null) {
    return makeMixerInsertDiff({
      identity: ["insert", match.old.index],
      kind: "removed",
      index: match.old.index,
      name: match.old.name,
      humanLabel: `Removed ${insertLabel(match.old)}`,
    });
  }

  const oldIns = match.old!;
  const newIns = match.new!;
  const path = `mixer.inserts[${oldIns.index}]`;
  const changes: Change[] = [];
  const push = (c: Change | null) => {
    if (c !== null) changes.push(c);
  };

  if (oldIns.name !== newIns.name) {
    push(
      scalarChange(
        `${path}.name`,
        oldIns.name,
        newIns.name,
        `Insert renamed from ${fmtNoneFriendly(oldIns.name)} to ${fmtNoneFriendly(newIns.name)}`,
      ),
    );
  }
  if (!deepEqual(oldIns.color, newIns.color)) {
    push(
      scalarChange(
        `${path}.color`,
        oldIns.color,
        newIns.color,
        `Insert color: ${colorHex(oldIns.color)} → ${colorHex(newIns.color)}`,
      ),
    );
  }
  if (oldIns.enabled !== newIns.enabled) {
    push(
      scalarChange(
        `${path}.enabled`,
        oldIns.enabled,
        newIns.enabled,
        `Insert ${fmtBool(newIns.enabled)} (was ${fmtBool(oldIns.enabled)})`,
      ),
    );
  }
  if (oldIns.locked !== newIns.locked) {
    push(
      scalarChange(
        `${path}.locked`,
        oldIns.locked,
        newIns.locked,
        `Insert ${newIns.locked ? "locked" : "unlocked"}`,
      ),
    );
  }
  if (oldIns.volume !== newIns.volume) {
    push(
      scalarChange(
        `${path}.volume`,
        oldIns.volume,
        newIns.volume,
        `Insert volume ${fmtPct(oldIns.volume)} → ${fmtPct(newIns.volume)}`,
      ),
    );
  }
  if (oldIns.pan !== newIns.pan) {
    push(
      scalarChange(
        `${path}.pan`,
        oldIns.pan,
        newIns.pan,
        `Insert pan ${fmtPan(oldIns.pan)} → ${fmtPan(newIns.pan)}`,
      ),
    );
  }
  if (oldIns.stereo_separation !== newIns.stereo_separation) {
    push(
      scalarChange(
        `${path}.stereo_separation`,
        oldIns.stereo_separation,
        newIns.stereo_separation,
        `Stereo separation ${fmtPct(oldIns.stereo_separation)} → ${fmtPct(newIns.stereo_separation)}`,
      ),
    );
  }
  if (!deepEqual(oldIns.routes_to, newIns.routes_to)) {
    // Python renders as `list(old.routes_to) → list(new.routes_to)` so
    // the brackets appear even for tuples on the Python side.
    push(
      makeChange({
        path: `${path}.routes_to`,
        kind: "modified",
        oldValue: oldIns.routes_to,
        newValue: newIns.routes_to,
        humanLabel: `Insert routing changed: ${pythonListRepr(oldIns.routes_to)} → ${pythonListRepr(newIns.routes_to)}`,
      }),
    );
  }

  const slotChanges = compareSlots(`${path}.slots`, oldIns.slots, newIns.slots);
  changes.push(...slotChanges);

  const nTotal = changes.length;
  const label =
    nTotal > 0 ? `${insertLabel(oldIns)} modified (${nTotal} changes)` : `${insertLabel(oldIns)} unchanged`;

  return makeMixerInsertDiff({
    identity: ["insert", oldIns.index],
    kind: "modified",
    index: oldIns.index,
    name: oldIns.name,
    humanLabel: label,
    changes,
  });
}

/** Python's `repr(list)` for simple number lists: `[1, 2, 3]` / `[]`. */
function pythonListRepr(arr: readonly number[]): string {
  return `[${arr.join(", ")}]`;
}

/**
 * Aggregate per-insert diffs into a `MixerDiff`. Only inserts with a
 * non-trivial diff (added/removed, or modified-with-changes) make it in.
 * Unchanged inserts are dropped.
 */
export function compareMixer(matches: readonly Match<InsertJson>[]): MixerDiff {
  const insertDiffs: MixerInsertDiff[] = [];
  for (const m of matches) {
    const d = compareMixerInsert(m);
    if (d.kind === "added" || d.kind === "removed" || d.changes.length > 0) {
      insertDiffs.push(d);
    }
  }
  return makeMixerDiff({ inserts: insertDiffs });
}

/**
 * Convenience: match mixer inserts at the JSON level + compare, same
 * pattern as `compareProjectsJson` uses for channels.
 */
export function compareMixerFromJson(
  oldInserts: readonly InsertJson[],
  newInserts: readonly InsertJson[],
): MixerDiff {
  const matches = pairByKey(
    oldInserts,
    newInserts,
    (i) => i.index,
    (i) => i.name || undefined,
  );
  return compareMixer(matches);
}
