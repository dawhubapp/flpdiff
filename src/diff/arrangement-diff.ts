/**
 * Arrangement, track, and per-clip diff. Ports `flp_diff.comparator`
 * sections for compare_arrangement / compare_track / _diff_track_items
 * and the three clip-collapse group builders (move/bulk/modify).
 *
 * Clip collapse reference (all three sibling types): when ≥3 sibling
 * playlist-item changes on the same track share the same ref + shape
 * signature, we collapse them into one summary line while keeping the
 * individual Changes around on TrackDiff.changes. JSON consumers and
 * `--verbose` see everything; the text formatter hides the members
 * behind the group summary line.
 */

import { pairByKey, type Match } from "./matcher.ts";
import {
  makeChange,
  makeTrackDiff,
  makeArrangementDiff,
  makeClipMoveGroup,
  makeClipBulkGroup,
  makeClipModifyGroup,
  type Change,
  type TrackDiff,
  type ArrangementDiff,
  type ClipMoveGroup,
  type ClipBulkGroup,
  type ClipModifyGroup,
} from "./diff-model.ts";
import {
  classify,
  fmtNoneFriendly,
  colorHex,
  scalarChange,
} from "./comparator.ts";
import { describePositionDelta } from "./note-diff.ts";
import type { FlpInfoJson } from "../presentation/flp-info.ts";

type TrackJson = FlpInfoJson["arrangements"][number]["tracks"][number];
type ArrJson = FlpInfoJson["arrangements"][number];
type ClipJson = TrackJson["items"][number];
type ChannelJson = FlpInfoJson["channels"][number];
type PatternJson = FlpInfoJson["patterns"][number];

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
  for (const k of ak) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return Object.keys(b as object).length === ak.length;
}

// --------------------------------------------------------------------- //
// Beat formatting                                                       //
// --------------------------------------------------------------------- //

/**
 * Render `ticks` as a short beat-count string (`"4"`, `"4.5"`, `"62.01"`).
 * Python: `_fmt_beats`.
 */
export function fmtBeats(ticks: number, ppq: number): string {
  if (ppq <= 0) return `${ticks}t`;
  const beats = ticks / ppq;
  if (Number.isInteger(beats)) return String(beats);
  // Python uses `f"{beats:.3f}".rstrip("0").rstrip(".")` — 3 decimals then
  // trim trailing zeros and the decimal point.
  const s = beats.toFixed(3);
  return s.replace(/\.?0+$/, "");
}

function clipLocator(item: ClipJson, ppq: number): string {
  return `at beat ${fmtBeats(item.position, ppq)}`;
}

function clipLengthSuffix(item: ClipJson, ppq: number): string {
  if (item.length <= 0) return "";
  return `, length ${fmtBeats(item.length, ppq)} beats`;
}

// --------------------------------------------------------------------- //
// Clip reference labels                                                 //
// --------------------------------------------------------------------- //

/** Python's `_clip_ref_key`: namespace patterns vs channels separately. */
function clipRefKey(item: ClipJson): number {
  if (item.pattern_iid !== null) return 10_000_000 + item.pattern_iid;
  if (item.channel_iid !== null) return item.channel_iid;
  return -1;
}

/** Human label for WHAT a clip refers to (not where it sits). */
function clipRefLabel(
  item: ClipJson,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
): string {
  if (item.pattern_iid !== null) {
    const p = patternsByIid.get(item.pattern_iid);
    const name = p?.name ?? `#${item.pattern_iid}`;
    return `pattern '${name}'`;
  }
  if (item.channel_iid !== null) {
    const ch = channelsByIid.get(item.channel_iid);
    if (ch !== undefined) {
      // Python special-cases "audio" kind + sample_path.name, but our
      // flp-info JSON only emits sampler/instrument/etc. — fall through.
      if (ch.kind === "automation") {
        const name = ch.name ?? `#${item.channel_iid}`;
        return `automation clip '${name}'`;
      }
      const name = ch.name ?? `#${item.channel_iid}`;
      return `clip '${name}'`;
    }
    return `clip #${item.channel_iid}`;
  }
  return "empty clip";
}

/** Post-prefix portion of "Added clip: X" / "Removed clip: X". */
function clipFullLabel(
  item: ClipJson,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): string {
  const ref = clipRefLabel(item, channelsByIid, patternsByIid);
  // Strip leading "clip " so "Added clip: clip 'X'" doesn't stutter.
  const stripped = ref.startsWith("clip ") ? ref.substring(5) : ref;
  return `${stripped} ${clipLocator(item, ppq)}${clipLengthSuffix(item, ppq)}`;
}

// --------------------------------------------------------------------- //
// Per-clip change builders                                              //
// --------------------------------------------------------------------- //

function buildClipModified(
  oldItem: ClipJson,
  newItem: ClipJson,
  pathPrefix: string,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): Change {
  const parts: string[] = [];
  if (oldItem.length !== newItem.length) {
    parts.push(`length ${fmtBeats(oldItem.length, ppq)} → ${fmtBeats(newItem.length, ppq)} beats`);
  }
  if (oldItem.muted !== newItem.muted) {
    parts.push(newItem.muted ? "muted" : "unmuted");
  }
  const detail = parts.length > 0 ? parts.join(", ") : "<unchanged>";
  const ref = clipRefLabel(oldItem, channelsByIid, patternsByIid);
  return makeChange({
    path: pathPrefix,
    kind: "modified",
    oldValue: oldItem,
    newValue: newItem,
    humanLabel: `${ref} ${clipLocator(oldItem, ppq)}: ${detail}`,
  });
}

function buildClipMoved(
  oldItem: ClipJson,
  newItem: ClipJson,
  pathPrefix: string,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): Change {
  const ref = clipRefLabel(newItem, channelsByIid, patternsByIid);
  const shift = describePositionDelta(newItem.position - oldItem.position, ppq);
  const extras: string[] = [];
  if (oldItem.length !== newItem.length) {
    extras.push(`length ${fmtBeats(oldItem.length, ppq)} → ${fmtBeats(newItem.length, ppq)} beats`);
  }
  if (oldItem.muted !== newItem.muted) {
    extras.push(newItem.muted ? "muted" : "unmuted");
  }
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return makeChange({
    path: pathPrefix,
    kind: "modified",
    oldValue: oldItem,
    newValue: newItem,
    humanLabel: `${ref} moved from beat ${fmtBeats(oldItem.position, ppq)} to beat ${fmtBeats(newItem.position, ppq)} (${shift})${suffix}`,
  });
}

// --------------------------------------------------------------------- //
// Three-pass per-clip matcher (exact / moved / added / removed)         //
// --------------------------------------------------------------------- //

function diffTrackItems(
  oldItems: readonly ClipJson[],
  newItems: readonly ClipJson[],
  trackIndex: number,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): Change[] {
  if (deepEqual(oldItems, newItems)) return [];

  // Pass 1: exact (ref, position) match.
  const oldByExact = new Map<string, number[]>();
  for (let i = 0; i < oldItems.length; i++) {
    const it = oldItems[i]!;
    const key = `${clipRefKey(it)}\x00${it.position}`;
    const bucket = oldByExact.get(key);
    if (bucket) bucket.push(i);
    else oldByExact.set(key, [i]);
  }

  const consumedOld = new Set<number>();
  const consumedNew = new Set<number>();
  const exactMods: [number, Change][] = [];

  for (let j = 0; j < newItems.length; j++) {
    const newItem = newItems[j]!;
    const key = `${clipRefKey(newItem)}\x00${newItem.position}`;
    const bucket = oldByExact.get(key);
    if (!bucket) continue;
    let oldIdx: number | undefined;
    for (const idx of bucket) {
      if (!consumedOld.has(idx)) {
        oldIdx = idx;
        break;
      }
    }
    if (oldIdx === undefined) continue;
    consumedOld.add(oldIdx);
    consumedNew.add(j);
    const oldItem = oldItems[oldIdx]!;
    if (deepEqual(oldItem, newItem)) continue;
    const path = `tracks[${trackIndex}].items[${oldIdx}]`;
    exactMods.push([
      oldIdx,
      buildClipModified(oldItem, newItem, path, channelsByIid, patternsByIid, ppq),
    ]);
  }
  exactMods.sort((a, b) => a[0] - b[0]);
  const changes: Change[] = [];
  for (const [, c] of exactMods) changes.push(c);

  // Pass 2: same ref, different position → moved (nearest-position greedy).
  const oldByRef = new Map<number, number[]>();
  for (let i = 0; i < oldItems.length; i++) {
    if (consumedOld.has(i)) continue;
    const refK = clipRefKey(oldItems[i]!);
    const bucket = oldByRef.get(refK);
    if (bucket) bucket.push(i);
    else oldByRef.set(refK, [i]);
  }

  const moveChanges: [number, Change][] = [];
  for (let j = 0; j < newItems.length; j++) {
    if (consumedNew.has(j)) continue;
    const newItem = newItems[j]!;
    const bucket = oldByRef.get(clipRefKey(newItem));
    if (!bucket) continue;
    let bestI: number | undefined;
    let bestDelta: number | undefined;
    for (const i of bucket) {
      if (consumedOld.has(i)) continue;
      const delta = Math.abs(oldItems[i]!.position - newItem.position);
      if (bestDelta === undefined || delta < bestDelta) {
        bestDelta = delta;
        bestI = i;
      }
    }
    if (bestI === undefined) continue;
    consumedOld.add(bestI);
    consumedNew.add(j);
    const path = `tracks[${trackIndex}].items[${bestI}]`;
    moveChanges.push([
      bestI,
      buildClipMoved(oldItems[bestI]!, newItem, path, channelsByIid, patternsByIid, ppq),
    ]);
  }
  moveChanges.sort((a, b) => a[0] - b[0]);
  for (const [, c] of moveChanges) changes.push(c);

  // Pass 3: removed + added leftovers.
  for (let i = 0; i < oldItems.length; i++) {
    if (consumedOld.has(i)) continue;
    const item = oldItems[i]!;
    changes.push(
      makeChange({
        path: `tracks[${trackIndex}].items[${i}]`,
        kind: "removed",
        oldValue: item,
        newValue: null,
        humanLabel: `Removed clip: ${clipFullLabel(item, channelsByIid, patternsByIid, ppq)}`,
      }),
    );
  }
  for (let j = 0; j < newItems.length; j++) {
    if (consumedNew.has(j)) continue;
    const item = newItems[j]!;
    changes.push(
      makeChange({
        path: `tracks[${trackIndex}].items[${j}]`,
        kind: "added",
        oldValue: null,
        newValue: item,
        humanLabel: `Added clip: ${clipFullLabel(item, channelsByIid, patternsByIid, ppq)}`,
      }),
    );
  }

  return changes;
}

// --------------------------------------------------------------------- //
// Clip-collapse groups (ClipMove / ClipBulk / ClipModify)               //
// --------------------------------------------------------------------- //

const MIN_CLIP_GROUP_SIZE = 3;

/**
 * Collapse same-ref, same-delta, pure-position moves (length + muted
 * unchanged) into `ClipMoveGroup`s. "Pure" keeps mixed-change clips on
 * their own so information isn't hidden behind the summary.
 */
function buildClipMoveGroups(
  itemChanges: readonly Change[],
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): ClipMoveGroup[] {
  type Bucket = [change: Change, oldItem: ClipJson, newItem: ClipJson][];
  const buckets = new Map<string, Bucket>();
  for (const c of itemChanges) {
    const oldV = c.oldValue as ClipJson | null;
    const newV = c.newValue as ClipJson | null;
    if (oldV === null || newV === null) continue;
    if (typeof oldV !== "object" || typeof newV !== "object") continue;
    if ((oldV as ClipJson)._type !== "PlaylistItem" || (newV as ClipJson)._type !== "PlaylistItem") continue;
    if (oldV.length !== newV.length || oldV.muted !== newV.muted) continue;
    if (oldV.position === newV.position) continue;
    const key = `${clipRefKey(oldV)}\x00${newV.position - oldV.position}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push([c, oldV, newV]);
    else buckets.set(key, [[c, oldV, newV]]);
  }

  const groups: ClipMoveGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < MIN_CLIP_GROUP_SIZE) continue;
    const delta = Number(key.split("\x00")[1]);
    members.sort((a, b) => a[1].position - b[1].position);
    const refLabel = clipRefLabel(members[0]![1], channelsByIid, patternsByIid);
    const shiftDesc = describePositionDelta(delta, ppq);
    const positions: [number, number][] = members.map(([, o, n]) => [o.position, n.position]);
    const changePaths = members.map(([c]) => c.path);

    let posSummary: string;
    if (positions.length <= 3) {
      posSummary = `beat ${positions.map(([o, n]) => `${fmtBeats(o, ppq)}→${fmtBeats(n, ppq)}`).join(", ")}`;
    } else {
      const [firstOld, firstNew] = positions[0]!;
      const [lastOld, lastNew] = positions[positions.length - 1]!;
      posSummary = `beats ${fmtBeats(firstOld, ppq)}→${fmtBeats(firstNew, ppq)} … ${fmtBeats(lastOld, ppq)}→${fmtBeats(lastNew, ppq)}`;
    }
    // Avoid "8 clips of clip 'X'" stutter.
    const groupRef = refLabel.startsWith("clip ") ? refLabel.substring(5) : refLabel;
    const humanLabel = `${members.length} clips of ${groupRef} moved ${shiftDesc} (${posSummary})`;

    groups.push(
      makeClipMoveGroup({
        refLabel,
        deltaTicks: delta,
        count: members.length,
        positions,
        changePaths,
        humanLabel,
      }),
    );
  }
  groups.sort((a, b) => a.positions[0]![0] - b.positions[0]![0]);
  return groups;
}

/**
 * Collapse same-ref same-length same-muted added/removed clip runs
 * into `ClipBulkGroup`s. Group key is (kind, ref, length, muted) —
 * strict so different-length clips don't hide behind a misleading
 * count.
 */
function buildClipBulkGroups(
  itemChanges: readonly Change[],
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): ClipBulkGroup[] {
  type Bucket = [change: Change, item: ClipJson][];
  const buckets = new Map<string, Bucket>();
  for (const c of itemChanges) {
    if (c.kind !== "added" && c.kind !== "removed") continue;
    const item = (c.kind === "added" ? c.newValue : c.oldValue) as ClipJson | null;
    if (item === null || typeof item !== "object") continue;
    if (item._type !== "PlaylistItem") continue;
    const key = `${c.kind}\x00${clipRefKey(item)}\x00${item.length}\x00${item.muted ? 1 : 0}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push([c, item]);
    else buckets.set(key, [[c, item]]);
  }

  const groups: ClipBulkGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < MIN_CLIP_GROUP_SIZE) continue;
    const parts = key.split("\x00");
    const kind = parts[0] as "added" | "removed";
    const length = Number(parts[2]);
    const muted = parts[3] === "1";
    members.sort((a, b) => a[1].position - b[1].position);
    const refLabel = clipRefLabel(members[0]![1], channelsByIid, patternsByIid);
    const groupRef = refLabel.startsWith("clip ") ? refLabel.substring(5) : refLabel;
    const positions = members.map(([, it]) => it.position);
    const changePaths = members.map(([c]) => c.path);
    const lengthStr = fmtBeats(length, ppq);
    const verb = kind === "added" ? "added" : "removed";

    let posSummary: string;
    if (positions.length <= 3) {
      posSummary = `beats ${positions.map((p) => fmtBeats(p, ppq)).join(", ")}`;
    } else {
      posSummary = `beats ${fmtBeats(positions[0]!, ppq)} … ${fmtBeats(positions[positions.length - 1]!, ppq)}`;
    }
    const mutedSuffix = muted ? ", muted" : "";
    const humanLabel = `${members.length} clips of ${groupRef} ${verb} (length ${lengthStr} beats${mutedSuffix}, ${posSummary})`;

    groups.push(
      makeClipBulkGroup({
        kind,
        refLabel,
        lengthTicks: length,
        muted,
        count: members.length,
        positions,
        changePaths,
        humanLabel,
      }),
    );
  }
  groups.sort((a, b) => a.positions[0]! - b.positions[0]!);
  return groups;
}

/**
 * Collapse same-ref in-place modifications (length change + muted toggle
 * at fixed positions) into `ClipModifyGroup`s. Skips moves (those go to
 * `buildClipMoveGroups`).
 */
function buildClipModifyGroups(
  itemChanges: readonly Change[],
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): ClipModifyGroup[] {
  type Bucket = [change: Change, oldItem: ClipJson, newItem: ClipJson][];
  const buckets = new Map<string, Bucket>();
  for (const c of itemChanges) {
    if (c.kind !== "modified") continue;
    const oldV = c.oldValue as ClipJson | null;
    const newV = c.newValue as ClipJson | null;
    if (oldV === null || newV === null || typeof oldV !== "object" || typeof newV !== "object") continue;
    if (oldV._type !== "PlaylistItem" || newV._type !== "PlaylistItem") continue;
    if (oldV.position !== newV.position) continue; // moves go to ClipMoveGroup
    if (oldV.length === newV.length && oldV.muted === newV.muted) continue;
    const key = `${clipRefKey(oldV)}\x00${oldV.length}\x00${newV.length}\x00${oldV.muted ? 1 : 0}\x00${newV.muted ? 1 : 0}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push([c, oldV, newV]);
    else buckets.set(key, [[c, oldV, newV]]);
  }

  const groups: ClipModifyGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < MIN_CLIP_GROUP_SIZE) continue;
    const parts = key.split("\x00");
    const oldLength = Number(parts[1]);
    const newLength = Number(parts[2]);
    const oldMuted = parts[3] === "1";
    const newMuted = parts[4] === "1";

    members.sort((a, b) => a[1].position - b[1].position);
    const refLabel = clipRefLabel(members[0]![1], channelsByIid, patternsByIid);
    const groupRef = refLabel.startsWith("clip ") ? refLabel.substring(5) : refLabel;
    const positions = members.map(([, o]) => o.position);
    const changePaths = members.map(([c]) => c.path);

    const detailParts: string[] = [];
    if (oldLength !== newLength) {
      detailParts.push(`length ${fmtBeats(oldLength, ppq)} → ${fmtBeats(newLength, ppq)} beats`);
    }
    if (oldMuted !== newMuted) {
      detailParts.push(newMuted ? "muted" : "unmuted");
    }
    const detail = detailParts.join(", ");

    let posSummary: string;
    if (positions.length <= 3) {
      posSummary = `beats ${positions.map((p) => fmtBeats(p, ppq)).join(", ")}`;
    } else {
      posSummary = `beats ${fmtBeats(positions[0]!, ppq)} … ${fmtBeats(positions[positions.length - 1]!, ppq)}`;
    }
    const humanLabel = `${members.length} clips of ${groupRef} modified (${detail}, ${posSummary})`;

    groups.push(
      makeClipModifyGroup({
        refLabel,
        oldLengthTicks: oldLength,
        newLengthTicks: newLength,
        oldMuted,
        newMuted,
        count: members.length,
        positions,
        changePaths,
        humanLabel,
      }),
    );
  }
  groups.sort((a, b) => a.positions[0]! - b.positions[0]!);
  return groups;
}

// --------------------------------------------------------------------- //
// Track diff                                                            //
// --------------------------------------------------------------------- //

function trackLabel(t: TrackJson): string {
  const name = t.name ?? `#${t.index}`;
  return `track '${name}'`;
}

/**
 * Python's `str.capitalize()` — uppercase first char, lowercase all
 * others. Matches "Track 'name'" → "Track 'name'" (no change if name
 * is already lowercase), "track 'Foo'" → "Track 'foo'" (lowers inner).
 */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

export function compareTrack(
  match: Match<TrackJson>,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): TrackDiff {
  if (match.old === null && match.new !== null) {
    return makeTrackDiff({
      identity: ["track", match.new.index],
      kind: "added",
      index: match.new.index,
      name: match.new.name,
      humanLabel: `Added ${trackLabel(match.new)}`,
    });
  }
  if (match.old !== null && match.new === null) {
    return makeTrackDiff({
      identity: ["track", match.old.index],
      kind: "removed",
      index: match.old.index,
      name: match.old.name,
      humanLabel: `Removed ${trackLabel(match.old)}`,
    });
  }

  const oldT = match.old!;
  const newT = match.new!;
  const path = `tracks[${oldT.index}]`;
  const changes: Change[] = [];
  const push = (c: Change | null) => {
    if (c !== null) changes.push(c);
  };

  if (oldT.name !== newT.name) {
    push(
      scalarChange(
        `${path}.name`,
        oldT.name,
        newT.name,
        `Track renamed from ${fmtNoneFriendly(oldT.name)} to ${fmtNoneFriendly(newT.name)}`,
      ),
    );
  }
  if (!deepEqual(oldT.color, newT.color)) {
    push(
      scalarChange(
        `${path}.color`,
        oldT.color,
        newT.color,
        `Track color: ${colorHex(oldT.color)} → ${colorHex(newT.color)}`,
      ),
    );
  }
  if (oldT.height !== newT.height) {
    push(
      scalarChange(
        `${path}.height`,
        oldT.height,
        newT.height,
        `Track height: ${fmtNoneFriendly(oldT.height)} → ${fmtNoneFriendly(newT.height)}`,
      ),
    );
  }
  if (oldT.muted !== newT.muted) {
    push(
      scalarChange(
        `${path}.muted`,
        oldT.muted,
        newT.muted,
        `Track ${newT.muted ? "muted" : "unmuted"}`,
      ),
    );
  }

  const itemChanges = diffTrackItems(oldT.items, newT.items, oldT.index, channelsByIid, patternsByIid, ppq);
  changes.push(...itemChanges);

  const clipMoveGroups = buildClipMoveGroups(itemChanges, channelsByIid, patternsByIid, ppq);
  const clipBulkGroups = buildClipBulkGroups(itemChanges, channelsByIid, patternsByIid, ppq);
  const clipModifyGroups = buildClipModifyGroups(itemChanges, channelsByIid, patternsByIid, ppq);

  const label =
    changes.length > 0
      ? `${capitalize(trackLabel(oldT))} modified (${changes.length} changes)`
      : `${capitalize(trackLabel(oldT))} unchanged`;

  return makeTrackDiff({
    identity: ["track", oldT.index],
    kind: "modified",
    index: oldT.index,
    name: oldT.name,
    humanLabel: label,
    changes,
    clipMoveGroups,
    clipBulkGroups,
    clipModifyGroups,
  });
}

// --------------------------------------------------------------------- //
// Arrangement diff                                                      //
// --------------------------------------------------------------------- //

function arrangementLabel(a: ArrJson): string {
  const name = a.name ?? `#${a.index}`;
  return `arrangement '${name}'`;
}

export function compareArrangement(
  match: Match<ArrJson>,
  channelsByIid: Map<number, ChannelJson>,
  patternsByIid: Map<number, PatternJson>,
  ppq: number,
): ArrangementDiff {
  if (match.old === null && match.new !== null) {
    return makeArrangementDiff({
      identity: ["arrangement", match.new.index],
      kind: "added",
      name: match.new.name,
      humanLabel: `Added ${arrangementLabel(match.new)}`,
    });
  }
  if (match.old !== null && match.new === null) {
    return makeArrangementDiff({
      identity: ["arrangement", match.old.index],
      kind: "removed",
      name: match.old.name,
      humanLabel: `Removed ${arrangementLabel(match.old)}`,
    });
  }

  const oldA = match.old!;
  const newA = match.new!;
  const changes: Change[] = [];
  const push = (c: Change | null) => {
    if (c !== null) changes.push(c);
  };

  if (oldA.name !== newA.name) {
    push(
      scalarChange(
        `arrangements[${oldA.index}].name`,
        oldA.name,
        newA.name,
        `Arrangement renamed from ${fmtNoneFriendly(oldA.name)} to ${fmtNoneFriendly(newA.name)}`,
      ),
    );
  }

  // Track-level diffs via the matcher (tracks are order-stable by index).
  const trackMatches = pairByKey(
    oldA.tracks,
    newA.tracks,
    (t) => t.index,
    (t) => t.name || undefined,
  );
  const allTrackDiffs = trackMatches.map((m) => compareTrack(m, channelsByIid, patternsByIid, ppq));
  const trackChanges = allTrackDiffs.filter(
    (td) => td.kind === "added" || td.kind === "removed" || td.changes.length > 0,
  );

  const label =
    changes.length > 0 || trackChanges.length > 0
      ? `${capitalize(arrangementLabel(oldA))} modified (${changes.length} arrangement changes, ${trackChanges.length} track changes)`
      : `${capitalize(arrangementLabel(oldA))} unchanged`;

  return makeArrangementDiff({
    identity: ["arrangement", oldA.index],
    kind: "modified",
    name: oldA.name,
    humanLabel: label,
    changes,
    trackChanges,
  });
}
