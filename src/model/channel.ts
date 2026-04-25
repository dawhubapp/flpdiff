/**
 * Channel kinds used by the TS parser.
 *
 * Opcode 0x15 (channel type) on the FLP event stream carries a uint8
 * whose value maps to a channel kind. Known values (verified against
 * Python's `flp-info` output on the 5 public fixtures):
 *
 *   0 → sampler
 *   2 → instrument (FL labels this "Native"; Python's flp-info renders
 *        it as "instrument" in human-readable output, and so do we for
 *        oracle parity)
 *   3 → layer
 *   4 → instrument
 *   5 → automation
 *
 * Unrecognized values (including the absence of a 0x15 event for a
 * channel) fall through to "unknown".
 */
export type ChannelKind = "sampler" | "instrument" | "layer" | "automation" | "unknown";

export type Channel = {
  /** Stable FL-assigned channel index from opcode 0x40. */
  iid: number;
  kind: ChannelKind;
};

export function classifyChannelKind(raw: number): ChannelKind {
  switch (raw) {
    case 0:
      return "sampler";
    case 2:
    case 4:
      return "instrument";
    case 3:
      return "layer";
    case 5:
      return "automation";
    default:
      return "unknown";
  }
}

/**
 * Counts of channels grouped by kind, in the order Python's `flp-info`
 * renders them ("2 samplers, 1 instrument") — see `formatChannelSummary`.
 */
export type ChannelCountsByKind = Record<ChannelKind, number>;

export function countChannelsByKind(channels: readonly Channel[]): ChannelCountsByKind {
  const counts: ChannelCountsByKind = {
    sampler: 0,
    instrument: 0,
    layer: 0,
    automation: 0,
    unknown: 0,
  };
  for (const ch of channels) counts[ch.kind]++;
  return counts;
}

/**
 * Human-readable summary matching Python's `flp-info` convention:
 *   "1 sampler"
 *   "2 samplers"
 *   "1 instrument, 1 sampler"   (alphabetical by kind name)
 */
export function formatChannelSummary(counts: ChannelCountsByKind): string {
  const parts: string[] = [];
  const order: ChannelKind[] = ["automation", "instrument", "layer", "sampler", "unknown"];
  for (const k of order) {
    const n = counts[k];
    if (n === 0) continue;
    parts.push(`${n} ${pluralize(k, n)}`);
  }
  return parts.join(", ") || "0 channels";
}

function pluralize(kind: ChannelKind, n: number): string {
  if (n === 1) return kind;
  if (kind === "unknown") return "unknown";
  return `${kind}s`;
}
