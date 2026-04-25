import type { FLPProject } from "./parser/flp-project.ts";
import { getTempo } from "./parser/flp-project.ts";
import type { RGBA, Levels } from "./model/channel.ts";
import type { Note } from "./model/pattern.ts";
import type { Clip } from "./model/arrangement.ts";

/**
 * Flat structural snapshot of what the parser currently decodes. Omits
 * the raw event list (`events`) and the unparsed header scalar fields
 * we don't surface (format, n_channels) — this is the oracle-comparable
 * shape.
 *
 * Shape is intentionally small and frozen: the snapshot grows with new
 * parser features, and each field addition is an explicit oracle
 * update. New fields should be added as optional (`?`) so existing
 * oracle data stays valid.
 */
export type ProjectSummary = {
  ppq: number;
  tempo: number | undefined;
  channels: ChannelSummary[];
  inserts: InsertSummary[];
  patterns: PatternSummary[];
  arrangements: ArrangementSummary[];
};

export type ChannelSummary = {
  iid: number;
  kind: "sampler" | "instrument" | "layer" | "automation" | "unknown";
  name?: string;
  sample_path?: string;
  plugin?: { internalName: string; name?: string; vendor?: string };
  color?: RGBA;
  levels?: Levels;
};

export type SlotSummary = {
  index: number;
  pluginName?: string;
};

export type InsertSummary = {
  index: number;
  name?: string;
  color?: RGBA;
  icon?: number;
  output?: number;
  input?: number;
  slots: SlotSummary[];
};

export type PatternSummary = {
  id: number;
  name?: string;
  length?: number;
  color?: RGBA;
  looped?: boolean;
  notes: Note[];
};

export type ArrangementSummary = {
  id: number;
  name?: string;
  trackCount: number;
  clips: Clip[];
};

/**
 * Build a structural snapshot from a parsed `FLPProject`. Pure and
 * deterministic — same input always yields same output.
 */
export function buildProjectSummary(project: FLPProject): ProjectSummary {
  return {
    ppq: project.header.ppq,
    tempo: getTempo(project),
    channels: project.channels.map(pickChannel),
    inserts: project.inserts.map(pickInsert),
    patterns: project.patterns.map(pickPattern),
    arrangements: project.arrangements.map(pickArrangement),
  };
}

function pickChannel(ch: FLPProject["channels"][number]): ChannelSummary {
  const out: ChannelSummary = { iid: ch.iid, kind: ch.kind };
  if (ch.name !== undefined) out.name = ch.name;
  if (ch.sample_path !== undefined) out.sample_path = ch.sample_path;
  if (ch.plugin !== undefined) {
    out.plugin = { internalName: ch.plugin.internalName };
    if (ch.plugin.name !== undefined) out.plugin.name = ch.plugin.name;
    if (ch.plugin.vendor !== undefined) out.plugin.vendor = ch.plugin.vendor;
  }
  if (ch.color !== undefined) out.color = { ...ch.color };
  if (ch.levels !== undefined) out.levels = { ...ch.levels };
  return out;
}

function pickInsert(ins: FLPProject["inserts"][number]): InsertSummary {
  const out: InsertSummary = {
    index: ins.index,
    slots: ins.slots.map((s) => {
      const slot: SlotSummary = { index: s.index };
      if (s.pluginName !== undefined) slot.pluginName = s.pluginName;
      return slot;
    }),
  };
  if (ins.name !== undefined) out.name = ins.name;
  if (ins.color !== undefined) out.color = { ...ins.color };
  if (ins.icon !== undefined) out.icon = ins.icon;
  if (ins.output !== undefined) out.output = ins.output;
  if (ins.input !== undefined) out.input = ins.input;
  return out;
}

function pickPattern(p: FLPProject["patterns"][number]): PatternSummary {
  const out: PatternSummary = { id: p.id, notes: p.notes.map((n) => ({ ...n })) };
  if (p.name !== undefined) out.name = p.name;
  if (p.length !== undefined) out.length = p.length;
  if (p.color !== undefined) out.color = { ...p.color };
  if (p.looped !== undefined) out.looped = p.looped;
  return out;
}

function pickArrangement(a: FLPProject["arrangements"][number]): ArrangementSummary {
  const out: ArrangementSummary = {
    id: a.id,
    trackCount: a.trackCount,
    clips: a.clips.map((c) => ({ ...c })),
  };
  if (a.name !== undefined) out.name = a.name;
  return out;
}
