/**
 * Semantic diff output model. Mirrors `flp_diff.diff_model` — every
 * dataclass becomes a TS type, every `__post_init__` check becomes a
 * validator function at construction helpers.
 *
 * Design principles (carried over from the Python reference):
 *
 * 1. **Pre-rendered `humanLabel` on every change.** The label is the
 *    core UX — `"Tempo changed from 140.0 to 145.0 BPM"`, not
 *    `"metadata.tempo"`. Rendered once at diff time. Empty labels
 *    are rejected by the constructor helpers.
 *
 * 2. **Canonical path strings.** Every `Change` carries a `path`
 *    addressing its tree location: `"metadata.tempo"`,
 *    `"channels[2].volume"`, `"mixer.inserts[4].slots[1].plugin.name"`.
 *
 * 3. **Entity-grouped diffs over a flat stream.** `channelChanges`
 *    is a list of `ChannelDiff`, each bundling all property-level
 *    changes for one matched channel — so formatters render blocks
 *    instead of reconstructing groupings from path prefixes.
 *
 * 4. **Heterogeneous values are `unknown`.** The Change.oldValue /
 *    newValue fields carry whatever lives at `path`; forcing them
 *    into a tagged union would balloon the API with no payoff.
 */

// --------------------------------------------------------------------- //
// Primitives                                                            //
// --------------------------------------------------------------------- //

export type ChangeKind = "added" | "removed" | "modified";

/**
 * Finer-grained kind for note-level diffs inside a pattern.
 *   "moved"    — same (channel, key) note, position shifted.
 *   "modified" — same note, velocity/length/channel changed.
 */
export type NoteChangeKind = "added" | "removed" | "moved" | "modified";

export type AutomationChangeKind = "added" | "removed" | "modified";

// --------------------------------------------------------------------- //
// Leaf change types                                                     //
// --------------------------------------------------------------------- //

/**
 * A single property-level change anywhere in the canonical tree.
 * Used for scalar-valued differences (metadata fields, channel volume,
 * insert pan, track name). For note-level and opaque-blob changes, see
 * `NoteChange` and `OpaqueChange`.
 */
export type Change = {
  path: string;
  kind: ChangeKind;
  oldValue: unknown;
  newValue: unknown;
  humanLabel: string;
};

export function makeChange(c: Change): Change {
  if (!c.humanLabel) {
    throw new Error(`Change(path=${JSON.stringify(c.path)}) requires a non-empty humanLabel`);
  }
  return c;
}

/**
 * Per-note diff inside a pattern. `oldNote` and `newNote` are Note
 * instances (kept as `unknown` here to avoid a cross-module cycle;
 * comparators write typed values in).
 *
 * For `added`, only `newNote` is set; for `removed`, only `oldNote`.
 * For `moved` and `modified`, both are populated.
 */
export type NoteChange = {
  kind: NoteChangeKind;
  oldNote: unknown; // Note | null
  newNote: unknown; // Note | null
  humanLabel: string;
};

export function makeNoteChange(c: NoteChange): NoteChange {
  if (!c.humanLabel) throw new Error("NoteChange requires a non-empty humanLabel");
  return c;
}

/**
 * Per-keyframe diff on a controller / automation point.
 *   "added"    — new keyframe in `new`, nothing at the same position in `old`.
 *   "removed"  — keyframe present in `old`, nothing at the same position in `new`.
 *   "modified" — same position, `value` or `tension` differs.
 *
 * No `moved` kind — keyframes are position-anchored. A horizontal drag
 * surfaces as add+remove, which is honest about what actually changed.
 */
export type AutomationChange = {
  kind: AutomationChangeKind;
  oldPoint: unknown; // AutomationPoint | null
  newPoint: unknown; // AutomationPoint | null
  humanLabel: string;
};

export function makeAutomationChange(c: AutomationChange): AutomationChange {
  if (!c.humanLabel) throw new Error("AutomationChange requires a non-empty humanLabel");
  return c;
}

/**
 * A blob whose contents we can't interpret changed. We can report
 * location (mixer slot, channel plugin), old/new SHA-256, and size
 * delta — not *what inside* the blob changed.
 */
export type OpaqueChange = {
  path: string;
  locationLabel: string;
  oldSha256: string | null;
  newSha256: string | null;
  oldSize: number | null;
  newSize: number | null;
  humanLabel: string;
};

export function makeOpaqueChange(c: OpaqueChange): OpaqueChange {
  if (!c.humanLabel) throw new Error("OpaqueChange requires a non-empty humanLabel");
  return c;
}

// --------------------------------------------------------------------- //
// Entity-grouped diffs                                                  //
// --------------------------------------------------------------------- //

/**
 * All changes affecting one channel (matched, added, or removed).
 *
 * For `kind="added"`/`"removed"`, `changes` is typically empty — the
 * entity-level `humanLabel` describes the whole event. For
 * `kind="modified"`, `changes` enumerates per-property diffs.
 *
 * `automationChanges` carries per-keyframe diffs when the channel is
 * an automation clip (`kind="automation"`). Separate from `changes`
 * for the same reason `PatternDiff.noteChanges` is separate.
 */
export type ChannelDiff = {
  identity: readonly (string | number)[];
  kind: ChangeKind;
  name: string | null;
  humanLabel: string;
  changes: readonly Change[];
  automationChanges: readonly AutomationChange[];
};

export function makeChannelDiff(d: Partial<ChannelDiff> & Pick<ChannelDiff, "identity" | "kind" | "name" | "humanLabel">): ChannelDiff {
  if (!d.humanLabel) throw new Error("ChannelDiff requires a non-empty humanLabel");
  return {
    identity: d.identity,
    kind: d.kind,
    name: d.name,
    humanLabel: d.humanLabel,
    changes: d.changes ?? [],
    automationChanges: d.automationChanges ?? [],
  };
}

export type PatternDiff = {
  identity: readonly (string | number)[];
  kind: ChangeKind;
  name: string | null;
  humanLabel: string;
  changes: readonly Change[];
  noteChanges: readonly NoteChange[];
  controllerChanges: readonly AutomationChange[];
};

export function makePatternDiff(d: Partial<PatternDiff> & Pick<PatternDiff, "identity" | "kind" | "name" | "humanLabel">): PatternDiff {
  if (!d.humanLabel) throw new Error("PatternDiff requires a non-empty humanLabel");
  return {
    identity: d.identity,
    kind: d.kind,
    name: d.name,
    humanLabel: d.humanLabel,
    changes: d.changes ?? [],
    noteChanges: d.noteChanges ?? [],
    controllerChanges: d.controllerChanges ?? [],
  };
}

/**
 * Per-insert mixer diff. Slot-level changes flow through `changes`
 * with paths like `mixer.inserts[3].slots[1].plugin.name`.
 */
export type MixerInsertDiff = {
  identity: readonly (string | number)[];
  kind: ChangeKind;
  index: number;
  name: string | null;
  humanLabel: string;
  changes: readonly Change[];
};

export function makeMixerInsertDiff(d: Partial<MixerInsertDiff> & Pick<MixerInsertDiff, "identity" | "kind" | "index" | "name" | "humanLabel">): MixerInsertDiff {
  if (!d.humanLabel) throw new Error("MixerInsertDiff requires a non-empty humanLabel");
  return {
    identity: d.identity,
    kind: d.kind,
    index: d.index,
    name: d.name,
    humanLabel: d.humanLabel,
    changes: d.changes ?? [],
  };
}

export type MixerDiff = {
  inserts: readonly MixerInsertDiff[];
  changes: readonly Change[];
};

export function makeMixerDiff(d: Partial<MixerDiff> = {}): MixerDiff {
  return { inserts: d.inserts ?? [], changes: d.changes ?? [] };
}

export function isMixerDiffEmpty(m: MixerDiff): boolean {
  return m.inserts.length === 0 && m.changes.length === 0;
}

/**
 * Collapsed summary of several same-ref playlist clips that all
 * shifted by the same position delta on one track. See Python's
 * `ClipMoveGroup` for the full design rationale — triggered by 2+
 * sibling moves on the same ref; per-clip Changes still live on
 * `TrackDiff.changes` for JSON consumers and `--verbose`.
 */
export type ClipMoveGroup = {
  refLabel: string;
  deltaTicks: number;
  count: number;
  positions: readonly (readonly [number, number])[]; // [oldPos, newPos]
  changePaths: readonly string[];
  humanLabel: string;
};

export function makeClipMoveGroup(g: ClipMoveGroup): ClipMoveGroup {
  if (!g.humanLabel) throw new Error("ClipMoveGroup requires a non-empty humanLabel");
  if (g.count !== g.positions.length || g.count !== g.changePaths.length) {
    throw new Error("ClipMoveGroup count must match positions/changePaths length");
  }
  if (g.count < 2) throw new Error("ClipMoveGroup requires at least 2 members");
  return g;
}

/** Collapsed summary of N same-ref clips added/removed together on one track, same length + muted. */
export type ClipBulkGroup = {
  kind: "added" | "removed";
  refLabel: string;
  lengthTicks: number;
  muted: boolean;
  count: number;
  positions: readonly number[];
  changePaths: readonly string[];
  humanLabel: string;
};

export function makeClipBulkGroup(g: ClipBulkGroup): ClipBulkGroup {
  if (!g.humanLabel) throw new Error("ClipBulkGroup requires a non-empty humanLabel");
  if (g.count !== g.positions.length || g.count !== g.changePaths.length) {
    throw new Error("ClipBulkGroup count must match positions/changePaths length");
  }
  if (g.count < 2) throw new Error("ClipBulkGroup requires at least 2 members");
  return g;
}

/** Same-ref in-place clip modifications on one track: length/muted changes at fixed positions. */
export type ClipModifyGroup = {
  refLabel: string;
  oldLengthTicks: number;
  newLengthTicks: number;
  oldMuted: boolean;
  newMuted: boolean;
  count: number;
  positions: readonly number[];
  changePaths: readonly string[];
  humanLabel: string;
};

export function makeClipModifyGroup(g: ClipModifyGroup): ClipModifyGroup {
  if (!g.humanLabel) throw new Error("ClipModifyGroup requires a non-empty humanLabel");
  if (g.count !== g.positions.length || g.count !== g.changePaths.length) {
    throw new Error("ClipModifyGroup count must match positions/changePaths length");
  }
  if (g.count < 2) throw new Error("ClipModifyGroup requires at least 2 members");
  return g;
}

export type TrackDiff = {
  identity: readonly (string | number)[];
  kind: ChangeKind;
  index: number;
  name: string | null;
  humanLabel: string;
  changes: readonly Change[];
  clipMoveGroups: readonly ClipMoveGroup[];
  clipBulkGroups: readonly ClipBulkGroup[];
  clipModifyGroups: readonly ClipModifyGroup[];
};

export function makeTrackDiff(d: Partial<TrackDiff> & Pick<TrackDiff, "identity" | "kind" | "index" | "name" | "humanLabel">): TrackDiff {
  if (!d.humanLabel) throw new Error("TrackDiff requires a non-empty humanLabel");
  return {
    identity: d.identity,
    kind: d.kind,
    index: d.index,
    name: d.name,
    humanLabel: d.humanLabel,
    changes: d.changes ?? [],
    clipMoveGroups: d.clipMoveGroups ?? [],
    clipBulkGroups: d.clipBulkGroups ?? [],
    clipModifyGroups: d.clipModifyGroups ?? [],
  };
}

export type ArrangementDiff = {
  identity: readonly (string | number)[];
  kind: ChangeKind;
  name: string | null;
  humanLabel: string;
  changes: readonly Change[];
  trackChanges: readonly TrackDiff[];
};

export function makeArrangementDiff(d: Partial<ArrangementDiff> & Pick<ArrangementDiff, "identity" | "kind" | "name" | "humanLabel">): ArrangementDiff {
  if (!d.humanLabel) throw new Error("ArrangementDiff requires a non-empty humanLabel");
  return {
    identity: d.identity,
    kind: d.kind,
    name: d.name,
    humanLabel: d.humanLabel,
    changes: d.changes ?? [],
    trackChanges: d.trackChanges ?? [],
  };
}

// --------------------------------------------------------------------- //
// Top-level result                                                      //
// --------------------------------------------------------------------- //

/**
 * Aggregate counts + pre-rendered one-line summary label.
 *
 * `totalChanges` counts *entity containers* with changes. Per-note
 * deltas inside a pattern are aggregated into `noteChanges`
 * separately so the top-line summary can distinguish "3 patterns
 * modified, 47 notes tweaked" from "3 patterns modified (rename only)".
 *
 * `trackChanges` is kept separate from `arrangementChanges` for the
 * same reason — a typical FL project has exactly one arrangement,
 * so "1 arrangement" is useless as a headline; tracks-moved is what
 * matters.
 */
export type DiffSummary = {
  totalChanges: number;
  metadataChanges: number;
  channelChanges: number;
  patternChanges: number;
  mixerChanges: number;
  arrangementChanges: number;
  opaqueChanges: number;
  humanLabel: string;
  noteChanges: number;
  automationChanges: number;
  trackChanges: number;
};

export function makeDiffSummary(
  s: Partial<DiffSummary> &
    Pick<
      DiffSummary,
      | "totalChanges"
      | "metadataChanges"
      | "channelChanges"
      | "patternChanges"
      | "mixerChanges"
      | "arrangementChanges"
      | "opaqueChanges"
      | "humanLabel"
    >,
): DiffSummary {
  if (!s.humanLabel) throw new Error("DiffSummary requires a non-empty humanLabel");
  return {
    ...s,
    noteChanges: s.noteChanges ?? 0,
    automationChanges: s.automationChanges ?? 0,
    trackChanges: s.trackChanges ?? 0,
  };
}

export function diffSummaryHasChanges(s: DiffSummary): boolean {
  return (
    s.totalChanges > 0 ||
    s.noteChanges > 0 ||
    s.automationChanges > 0 ||
    s.trackChanges > 0
  );
}

/**
 * Top-level result of diffing two FLPProject instances. Empty tuples
 * and an empty MixerDiff indicate no changes in that branch. The
 * `summary` counts are cross-validated against the per-branch
 * contents via `computeSummaryCounts`.
 */
export type DiffResult = {
  summary: DiffSummary;
  metadataChanges: readonly Change[];
  channelChanges: readonly ChannelDiff[];
  patternChanges: readonly PatternDiff[];
  mixerChanges: MixerDiff;
  arrangementChanges: readonly ArrangementDiff[];
  opaqueChanges: readonly OpaqueChange[];
};

export function diffResultIsIdentical(r: DiffResult): boolean {
  return !diffSummaryHasChanges(r.summary);
}

// --------------------------------------------------------------------- //
// Helpers                                                               //
// --------------------------------------------------------------------- //

/**
 * Canonical counting recipe so summary numbers don't drift from
 * content. Mixer changes count every affected insert plus any
 * mixer-wide diff. Pattern changes count each PatternDiff once (not
 * per note); per-note counts are only in the human_label.
 */
export function computeSummaryCounts(args: {
  metadataChanges: readonly Change[];
  channelChanges: readonly ChannelDiff[];
  patternChanges: readonly PatternDiff[];
  mixerChanges: MixerDiff;
  arrangementChanges: readonly ArrangementDiff[];
  opaqueChanges: readonly OpaqueChange[];
}): {
  metadata: number;
  channels: number;
  patterns: number;
  mixer: number;
  arrangements: number;
  opaque: number;
  total: number;
} {
  const metadata = args.metadataChanges.length;
  const channels = args.channelChanges.length;
  const patterns = args.patternChanges.length;
  const mixer = args.mixerChanges.inserts.length + args.mixerChanges.changes.length;
  const arrangements = args.arrangementChanges.length;
  const opaque = args.opaqueChanges.length;
  return {
    metadata,
    channels,
    patterns,
    mixer,
    arrangements,
    opaque,
    total: metadata + channels + patterns + mixer + arrangements + opaque,
  };
}
