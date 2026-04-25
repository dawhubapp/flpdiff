import type { FLPProject } from "../parser/flp-project.ts";
import { getFLVersionBanner, getTempo } from "../parser/flp-project.ts";

export type Headline = {
  version: string | undefined;
  tempo: number | undefined;
  ppq: number;
};

export type HeadlineFieldDiff<T> =
  | { kind: "unchanged"; value: T }
  | { kind: "changed"; before: T; after: T };

export type HeadlineDiff = {
  version: HeadlineFieldDiff<string | undefined>;
  tempo: HeadlineFieldDiff<number | undefined>;
  ppq: HeadlineFieldDiff<number>;
  hasChanges: boolean;
};

export function extractHeadline(project: FLPProject): Headline {
  return {
    version: getFLVersionBanner(project),
    tempo: getTempo(project),
    ppq: project.header.ppq,
  };
}

function compare<T>(a: T, b: T): HeadlineFieldDiff<T> {
  return a === b ? { kind: "unchanged", value: a } : { kind: "changed", before: a, after: b };
}

export function diffHeadlines(a: Headline, b: Headline): HeadlineDiff {
  const version = compare(a.version, b.version);
  const tempo = compare(a.tempo, b.tempo);
  const ppq = compare(a.ppq, b.ppq);
  const hasChanges =
    version.kind === "changed" || tempo.kind === "changed" || ppq.kind === "changed";
  return { version, tempo, ppq, hasChanges };
}

function formatField<T>(
  label: string,
  diff: HeadlineFieldDiff<T>,
  render: (v: T) => string,
): string | undefined {
  if (diff.kind === "unchanged") return undefined;
  return `~ ${label}: ${render(diff.before)} → ${render(diff.after)}`;
}

const renderVersion = (v: string | undefined): string => (v === undefined ? "<unknown>" : v);
const renderTempo = (v: number | undefined): string =>
  v === undefined ? "<unknown>" : `${v.toFixed(1)} BPM`;
const renderPPQ = (v: number): string => String(v);

export function renderHeadlineDiff(diff: HeadlineDiff): string {
  if (!diff.hasChanges) return "No headline changes.";
  const lines = [
    formatField("Version", diff.version, renderVersion),
    formatField("Tempo", diff.tempo, renderTempo),
    formatField("PPQ", diff.ppq, renderPPQ),
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}
