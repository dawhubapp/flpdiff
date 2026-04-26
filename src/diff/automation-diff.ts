/**
 * Keyframe diff for pattern controllers (and, eventually, automation
 * channels). Ports `flp_diff.automation_diff` exactly.
 *
 * Matching strategy: **position-anchored**. Each keyframe's identity
 * is its position in ticks within the containing pattern / clip.
 *
 *   1. Exact position match on both sides → compare `value` /
 *      `tension`. Emit `modified` if either differs; drop if identical.
 *   2. Leftovers → `added` (new only) or `removed` (old only).
 *
 * Deliberately NO `moved` kind — a dragged keyframe has no stable
 * identity separate from its position. Horizontal drags surface as
 * one removed + one added, which is honest about what's on disk.
 * Merging add/remove pairs into a single "moved" event would require
 * a value-similarity heuristic that introduces false positives.
 *
 * Output is **timeline-ordered** (sorted by position ascending). When
 * multiple changes share a position, the tiebreaker is
 * `modified → removed → added`. A reader follows the curve left-to-
 * right like the piano roll rather than scanning kind-grouped chunks.
 */

import { makeAutomationChange, type AutomationChange } from "./diff-model.ts";
import { pythonGFormat } from "./note-diff.ts";

/** Matches the FlpInfoJson shape's AutomationPoint wrapper. */
export type AutomationPointJson = {
  _type: "AutomationPoint";
  position: number;
  value: number;
  tension: number;
};

function describePosition(position: number, ppq: number): string {
  const beat = ppq ? position / ppq : 0;
  return `beat ${pythonGFormat(beat)}`;
}

function buildModified(
  oldPt: AutomationPointJson,
  newPt: AutomationPointJson,
  ppq: number,
): AutomationChange {
  const parts: string[] = [];
  if (oldPt.value !== newPt.value) {
    parts.push(`value ${pythonGFormat(oldPt.value)} → ${pythonGFormat(newPt.value)}`);
  }
  if (oldPt.tension !== newPt.tension) {
    parts.push(`tension ${pythonGFormat(oldPt.tension)} → ${pythonGFormat(newPt.tension)}`);
  }
  const detail = parts.length > 0 ? parts.join(", ") : "<unchanged>";
  return makeAutomationChange({
    kind: "modified",
    oldPoint: oldPt,
    newPoint: newPt,
    humanLabel: `Keyframe at ${describePosition(oldPt.position, ppq)}: ${detail}`,
  });
}

function buildAdded(newPt: AutomationPointJson, ppq: number): AutomationChange {
  return makeAutomationChange({
    kind: "added",
    oldPoint: null,
    newPoint: newPt,
    humanLabel: `Added keyframe at ${describePosition(newPt.position, ppq)} (value ${pythonGFormat(newPt.value)})`,
  });
}

function buildRemoved(oldPt: AutomationPointJson, ppq: number): AutomationChange {
  return makeAutomationChange({
    kind: "removed",
    oldPoint: oldPt,
    newPoint: null,
    humanLabel: `Removed keyframe at ${describePosition(oldPt.position, ppq)} (value ${pythonGFormat(oldPt.value)})`,
  });
}

/**
 * Produce `AutomationChange[]` for one controller pair. See module
 * docstring for strategy + ordering guarantees.
 */
export function diffAutomationPoints(
  oldPts: readonly AutomationPointJson[],
  newPts: readonly AutomationPointJson[],
  ppq: number,
): AutomationChange[] {
  // Exact position match pass.
  const oldByPos = new Map<number, number[]>();
  for (let i = 0; i < oldPts.length; i++) {
    const pos = oldPts[i]!.position;
    const bucket = oldByPos.get(pos);
    if (bucket) bucket.push(i);
    else oldByPos.set(pos, [i]);
  }

  const consumedOld = new Set<number>();
  const consumedNew = new Set<number>();
  const modifieds: AutomationChange[] = [];

  for (let j = 0; j < newPts.length; j++) {
    const kf = newPts[j]!;
    const bucket = oldByPos.get(kf.position);
    if (!bucket) continue;
    let matchIdx: number | undefined;
    for (const i of bucket) {
      if (!consumedOld.has(i)) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === undefined) continue;
    consumedOld.add(matchIdx);
    consumedNew.add(j);
    const oldKf = oldPts[matchIdx]!;
    if (oldKf.value === kf.value && oldKf.tension === kf.tension) continue;
    modifieds.push(buildModified(oldKf, kf, ppq));
  }

  const removeds: AutomationChange[] = [];
  for (let i = 0; i < oldPts.length; i++) {
    if (!consumedOld.has(i)) removeds.push(buildRemoved(oldPts[i]!, ppq));
  }
  const addeds: AutomationChange[] = [];
  for (let j = 0; j < newPts.length; j++) {
    if (!consumedNew.has(j)) addeds.push(buildAdded(newPts[j]!, ppq));
  }

  // Timeline-ordered: (position, kind_rank) with modified → removed → added.
  const RANK: Record<"modified" | "removed" | "added", number> = {
    modified: 0,
    removed: 1,
    added: 2,
  };
  const out = [...modifieds, ...removeds, ...addeds];
  out.sort((a, b) => {
    const ap = (a.oldPoint ?? a.newPoint) as AutomationPointJson;
    const bp = (b.oldPoint ?? b.newPoint) as AutomationPointJson;
    if (ap.position !== bp.position) return ap.position - bp.position;
    return RANK[a.kind] - RANK[b.kind];
  });
  return out;
}
