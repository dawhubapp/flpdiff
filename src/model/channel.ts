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

/**
 * Plugin hosted on a channel.
 *
 * `internalName` is always set — it's FL's identifier for the plugin's
 * wrapper class, sourced from opcode `0xC9`. For FL-native plugins it
 * equals the plugin's display name (e.g. `"Fruity Parametric EQ 2"`).
 * For VST-hosted plugins it's `"Fruity Wrapper"` (FL's generic VST
 * host class).
 *
 * `name` and `vendor` are populated ONLY when the plugin is a VST
 * (internalName === `"Fruity Wrapper"`) — decoded from the `0xD5`
 * plugin-state blob's id-length-value record stream. See
 * `parser/vst-wrapper.ts`.
 */
export type ChannelPlugin = {
  internalName: string;
  /** VST display name (e.g. `"Serum"`). Set only for VST plugins. */
  name?: string;
  /** VST vendor string (e.g. `"Xfer Records"`). Set only for VSTs. */
  vendor?: string;
};

/**
 * 8-bit-per-channel RGBA color, stored as ints 0-255. FL serializes
 * colors as a uint32 LE in opcode `0x80` with bytes in `[R, G, B, A]`
 * order; this type preserves the raw integer bytes rather than
 * pre-normalizing to float, so consumers can choose their own
 * representation and the oracle stays byte-faithful.
 */
export type RGBA = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export function unpackRGBA(value: number): RGBA {
  return {
    r: value & 0xff,
    g: (value >> 8) & 0xff,
    b: (value >> 16) & 0xff,
    a: (value >> 24) & 0xff,
  };
}

/**
 * Per-channel raw levels struct from opcode `0xDB` on FL 25
 * (pre-FL-25 saves emit Levels at `0xCB`; the 24-byte struct
 * lives at `0xDB` on FL 25, one blob per channel).
 *
 * All values are raw FL-internal integers — no normalization to
 * 0..1. Consumers that want "normalized" values should divide:
 *   volume / 12800   (Python flp-info's convention, so 10000 → 0.78125)
 *   pan    / 6400    (Python flp-info's convention, so 6400 → 1.0)
 * Other fields stored as-is; interpretation depends on per-field
 * convention we haven't catalogued yet.
 */
export type Levels = {
  /** Raw pan. Default 6400 on a fresh channel. */
  pan: number;
  /** Raw volume. Default 10000 on a fresh channel (= 0.78125 normalized). */
  volume: number;
  /** Raw pitch-shift, default 0. */
  pitch_shift: number;
  /** Filter envelope mod-X. */
  filter_mod_x: number;
  /** Filter envelope mod-Y. */
  filter_mod_y: number;
  /** Filter type enum value (FastLP/LP/BP/HP/BS/LPx2/SVFLP/SVFLPx2, 0..7). */
  filter_type: number;
};

export function decodeLevels(payload: Uint8Array): Levels | undefined {
  if (payload.byteLength < 24) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    pan: view.getInt32(0, true),
    volume: view.getUint32(4, true),
    pitch_shift: view.getInt32(8, true),
    filter_mod_x: view.getUint32(12, true),
    filter_mod_y: view.getUint32(16, true),
    filter_type: view.getUint32(20, true),
  };
}

export type Channel = {
  /** Stable FL-assigned channel index from opcode 0x40. */
  iid: number;
  kind: ChannelKind;
  /**
   * Per-channel volume/pan/pitch-shift/filter struct decoded from the
   * 24-byte `0xDB` blob. Absent if FL didn't emit a Levels event on
   * this channel (shouldn't happen on modern FL 25 saves — every
   * channel carries a Levels blob even when values are defaults).
   */
  levels?: Levels;
  /**
   * Channel color from opcode `0x80`. FL assigns a default gray
   * (`{r: 65, g: 69, b: 72, a: 0}`) to fresh sampler channels;
   * users can override via the channel-rack color picker.
   */
  color?: RGBA;
  /**
   * User-visible channel name. Sourced from opcode `0xCB` (shared with
   * mixer-slot plugin names — the walker attributes it to the current
   * channel only while the current scope is a channel, not a slot).
   * On a freshly-saved base FL 25 sampler channel the default name is
   * `"Sampler"`.
   */
  name?: string;
  /**
   * Full sample-library path for sampler channels with a sample loaded.
   * Sourced from opcode `0xC4` (SamplePath), a UTF-16LE null-terminated
   * string in a DATA-range blob. Typical form includes FL's library
   * tokens, e.g. `%FLStudioFactoryData%/Data/Patches/Packs/Drums/…`.
   * Undefined for channels without a sample (non-sampler kinds, or
   * samplers before a file is dragged in).
   */
  sample_path?: string;
  /**
   * Plugin hosted on this channel. Set only for channels that actually
   * have a plugin loaded — sampler channels emit an empty `0xC9`, which
   * the walker treats as "no plugin" and leaves this field undefined.
   */
  plugin?: ChannelPlugin;
};

/**
 * Extract the filename component of a sample_path — the last
 * path segment after the final '/' or '\'. Mirrors what Python's
 * `flp-info` prints under "Samples:".
 */
export function sampleFilename(path: string): string {
  const lastFwd = path.lastIndexOf("/");
  const lastBack = path.lastIndexOf("\\");
  const i = Math.max(lastFwd, lastBack);
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Comma-separated filenames of channels with a sample, in declaration
 * order. Returns "(none)" when no channel carries one — matching the
 * convention in Python's `flp-info` output.
 */
export function formatSampleSummary(channels: readonly Channel[]): string {
  const names = channels
    .filter((c) => c.sample_path !== undefined)
    .map((c) => sampleFilename(c.sample_path!));
  return names.length === 0 ? "(none)" : names.join(", ");
}

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
