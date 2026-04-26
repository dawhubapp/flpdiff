export { parseFLPFile, getFLVersionBanner, getTempo } from "./parser/flp-project.ts";
export type { FLPProject, FLPHeader } from "./parser/flp-project.ts";
export type { FLPEvent } from "./parser/event.ts";
export { FLPParseError } from "./parser/errors.ts";
export type {
  Channel,
  ChannelKind,
  ChannelPlugin,
  RGBA,
  Levels,
  FilterTypeName,
} from "./model/channel.ts";
export {
  classifyChannelKind,
  countChannelsByKind,
  formatChannelSummary,
  formatSampleSummary,
  sampleFilename,
  unpackRGBA,
  decodeLevels,
  filterTypeName,
} from "./model/channel.ts";
export type {
  MixerInsert,
  MixerSlot,
  InsertFlags,
  MixerParamRecord,
} from "./model/mixer-insert.ts";
export {
  countNamedInserts,
  countActiveSlots,
  formatMixerSummary,
  decodeInsertFlags,
  decodeInsertRouting,
  decodeMixerParams,
} from "./model/mixer-insert.ts";
export type { Pattern, Note, Controller } from "./model/pattern.ts";
export { formatPatternSummary, decodeNotes, decodeControllers } from "./model/pattern.ts";
export type { Arrangement, Clip, TimeMarker, TimeMarkerKind } from "./model/arrangement.ts";
export { formatArrangementSummary, decodeClips, decodeTimeMarkerPosition } from "./model/arrangement.ts";
export type {
  ProjectSummary,
  ChannelSummary,
  SlotSummary,
  InsertSummary,
  PatternSummary,
  ArrangementSummary,
} from "./summary.ts";
export { buildProjectSummary } from "./summary.ts";
export type { FlpInfoJson } from "./presentation/flp-info.ts";
export { toFlpInfoJson } from "./presentation/flp-info.ts";
export { renderInfo } from "./info.ts";
export { renderCanonical, CANONICAL_HEADER } from "./canonical.ts";
export type {
  Change,
  ChangeKind,
  NoteChange,
  NoteChangeKind,
  AutomationChange,
  AutomationChangeKind,
  OpaqueChange,
  ChannelDiff,
  PatternDiff,
  MixerInsertDiff,
  MixerDiff,
  ClipMoveGroup,
  ClipBulkGroup,
  ClipModifyGroup,
  TrackDiff,
  ArrangementDiff,
  DiffSummary,
  DiffResult,
} from "./diff/diff-model.ts";
export {
  makeChange,
  makeNoteChange,
  makeAutomationChange,
  makeOpaqueChange,
  makeChannelDiff,
  makePatternDiff,
  makeMixerInsertDiff,
  makeMixerDiff,
  makeClipMoveGroup,
  makeClipBulkGroup,
  makeClipModifyGroup,
  makeTrackDiff,
  makeArrangementDiff,
  makeDiffSummary,
  isMixerDiffEmpty,
  diffSummaryHasChanges,
  diffResultIsIdentical,
  computeSummaryCounts,
} from "./diff/diff-model.ts";
export type { Match, MatchConfidence, ProjectMatch } from "./diff/matcher.ts";
export {
  matchChannels,
  matchPatterns,
  matchMixerInserts,
  matchTracks,
  matchArrangements,
  matchProjects,
  pairByKey,
  isMatched,
  isAdded,
  isRemoved,
} from "./diff/matcher.ts";
export {
  classify,
  fmtNoneFriendly,
  pythonFloatRepr,
  fmtPct,
  fmtPan,
  fmtTimeSig,
  fmtBool,
  colorHex,
  scalarChange,
  compareMetadata,
  compareChannel,
  compareProjectsJson,
  compareProjects,
} from "./diff/comparator.ts";
export {
  describePositionDelta,
  notePitchLabel,
  pythonGFormat,
  diffNotes,
} from "./diff/note-diff.ts";
export type { AutomationPointJson } from "./diff/automation-diff.ts";
export { diffAutomationPoints } from "./diff/automation-diff.ts";
export {
  compareSlots,
  compareMixerInsert,
  compareMixer,
  compareMixerFromJson,
} from "./diff/mixer-diff.ts";
export { fmtBeats, compareTrack, compareArrangement } from "./diff/arrangement-diff.ts";
export { comparePattern } from "./diff/comparator.ts";
export type { RenderSummaryOptions } from "./diff/summary.ts";
export { renderSummary } from "./diff/summary.ts";
