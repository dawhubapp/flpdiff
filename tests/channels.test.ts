import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseFLPFile,
  countChannelsByKind,
  formatChannelSummary,
  formatSampleSummary,
  sampleFilename,
  unpackRGBA,
  decodeLevels,
  filterTypeName,
  type Channel,
} from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");

async function channelsOf(name: string): Promise<Channel[]> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return parseFLPFile(buf).channels;
}

/**
 * Oracle values from `flp-info` on the same fixtures:
 *   base_empty        "Channels: 1 (1 sampler)"
 *   base_one_channel  "Channels: 2 (2 samplers)"
 *   base_one_insert   "Channels: 1 (1 sampler)"
 *   base_one_pattern  "Channels: 2 (2 samplers)"
 *   base_one_serum    "Channels: 2 (1 instrument, 1 sampler)"
 */
describe("Channel extraction — oracle parity with Python flp-info", () => {
  test("base_empty.flp: 1 sampler", async () => {
    const channels = await channelsOf("base_empty.flp");
    expect(channels.length).toBe(1);
    expect(channels[0]!.kind).toBe("sampler");
    expect(formatChannelSummary(countChannelsByKind(channels))).toBe("1 sampler");
  });

  test("base_one_channel.flp: 2 samplers", async () => {
    const channels = await channelsOf("base_one_channel.flp");
    expect(channels.length).toBe(2);
    expect(channels.map((c) => c.kind)).toEqual(["sampler", "sampler"]);
    expect(formatChannelSummary(countChannelsByKind(channels))).toBe("2 samplers");
  });

  test("base_one_insert.flp: 1 sampler", async () => {
    const channels = await channelsOf("base_one_insert.flp");
    expect(channels.length).toBe(1);
    expect(channels[0]!.kind).toBe("sampler");
    expect(formatChannelSummary(countChannelsByKind(channels))).toBe("1 sampler");
  });

  test("base_one_pattern.flp: 2 samplers", async () => {
    const channels = await channelsOf("base_one_pattern.flp");
    expect(channels.length).toBe(2);
    expect(channels.map((c) => c.kind)).toEqual(["sampler", "sampler"]);
    expect(formatChannelSummary(countChannelsByKind(channels))).toBe("2 samplers");
  });

  test("base_one_serum.flp: 1 instrument + 1 sampler", async () => {
    const channels = await channelsOf("base_one_serum.flp");
    expect(channels.length).toBe(2);
    // The Serum (native/instrument) channel should be distinguishable
    // from the sampler — raw channel-type enum values were [0, 2].
    const kinds = channels.map((c) => c.kind).sort();
    expect(kinds).toEqual(["instrument", "sampler"]);
    expect(formatChannelSummary(countChannelsByKind(channels))).toBe("1 instrument, 1 sampler");
  });
});

describe("Channel names (opcode 0xCB, scope-aware) — oracle parity", () => {
  test("base_empty.flp: default sampler name", async () => {
    const channels = await channelsOf("base_empty.flp");
    expect(channels.map((c) => c.name)).toEqual(["Sampler"]);
  });

  test("base_one_channel.flp: Sampler + Kick", async () => {
    const channels = await channelsOf("base_one_channel.flp");
    expect(channels.map((c) => c.name)).toEqual(["Sampler", "Kick"]);
  });

  test("base_one_pattern.flp: Sampler + Kick", async () => {
    const channels = await channelsOf("base_one_pattern.flp");
    expect(channels.map((c) => c.name)).toEqual(["Sampler", "Kick"]);
  });

  test("base_one_serum.flp: Sampler + SerumTest", async () => {
    const channels = await channelsOf("base_one_serum.flp");
    expect(channels.map((c) => c.name)).toEqual(["Sampler", "SerumTest"]);
  });

  test("base_one_insert.flp: channel name is 'Sampler' — NOT the plugin name", async () => {
    // Critical regression test: base_one_insert contains a mixer slot
    // with "Fruity Parametric EQ 2" as its plugin name, carried on the
    // SAME opcode (0xCB) as channel names. Without scope tracking, the
    // walker would steal the plugin name and attribute it to the
    // channel.
    const channels = await channelsOf("base_one_insert.flp");
    expect(channels.map((c) => c.name)).toEqual(["Sampler"]);
  });
});

describe("Sample paths (opcode 0xC4) — oracle parity", () => {
  const FACTORY_SAMPLE = "%FLStudioFactoryData%/Data/Patches/Packs/Drums/Kicks/909 Kick.wav";

  test("base_empty.flp: no samples", async () => {
    const channels = await channelsOf("base_empty.flp");
    expect(channels.every((c) => c.sample_path === undefined)).toBe(true);
    expect(formatSampleSummary(channels)).toBe("(none)");
  });

  test("base_one_channel.flp: one sample, full path + filename", async () => {
    const channels = await channelsOf("base_one_channel.flp");
    const withSample = channels.filter((c) => c.sample_path !== undefined);
    expect(withSample.length).toBe(1);
    expect(withSample[0]!.sample_path).toBe(FACTORY_SAMPLE);
    expect(formatSampleSummary(channels)).toBe("909 Kick.wav");
  });

  test("base_one_pattern.flp: same sample appears", async () => {
    const channels = await channelsOf("base_one_pattern.flp");
    expect(formatSampleSummary(channels)).toBe("909 Kick.wav");
  });

  test("base_one_insert.flp: no sample", async () => {
    const channels = await channelsOf("base_one_insert.flp");
    expect(formatSampleSummary(channels)).toBe("(none)");
  });

  test("base_one_serum.flp: no sample (Serum is a VST, not a sampler with a wav)", async () => {
    const channels = await channelsOf("base_one_serum.flp");
    expect(formatSampleSummary(channels)).toBe("(none)");
  });
});

describe("sampleFilename — pure path helper", () => {
  test("strips the last forward-slash segment", () => {
    expect(sampleFilename("%FLStudioFactoryData%/Data/Kicks/909 Kick.wav")).toBe("909 Kick.wav");
  });

  test("strips the last backslash segment (Windows-style)", () => {
    expect(sampleFilename("C:\\Users\\me\\Samples\\snare.wav")).toBe("snare.wav");
  });

  test("returns the whole string if no separator", () => {
    expect(sampleFilename("bare.wav")).toBe("bare.wav");
  });
});

describe("Channel-hosted plugin (opcode 0xC9)", () => {
  test.each([
    ["base_empty.flp"],
    ["base_one_channel.flp"],
    ["base_one_insert.flp"],
    ["base_one_pattern.flp"],
  ])("%s: sampler-only channels have no plugin", async (name) => {
    const channels = await channelsOf(name);
    for (const ch of channels) {
      expect(ch.plugin).toBeUndefined();
    }
  });

  test("base_one_serum.flp: channel[1] hosts Serum via Fruity Wrapper, with vendor", async () => {
    const channels = await channelsOf("base_one_serum.flp");
    // Channel 0 is the default sampler — no plugin
    expect(channels[0]!.plugin).toBeUndefined();
    // Channel 1 is Serum — VST wrapper decoded to expose the real
    // VST name and vendor from the 0xD5 state blob.
    expect(channels[1]!.plugin).toEqual({
      internalName: "Fruity Wrapper",
      name: "Serum",
      vendor: "Xfer Records",
    });
  });
});

describe("Channel color (opcode 0x80)", () => {
  const DEFAULT = { r: 65, g: 69, b: 72, a: 0 };
  const LIGHTER = { r: 92, g: 101, b: 106, a: 0 };

  test("base_empty: channel[0] gets FL's default gray", async () => {
    const channels = await channelsOf("base_empty.flp");
    expect(channels[0]!.color).toEqual(DEFAULT);
  });

  test("base_one_channel: channel[0] default gray + channel[1] lighter", async () => {
    const channels = await channelsOf("base_one_channel.flp");
    expect(channels[0]!.color).toEqual(DEFAULT);
    expect(channels[1]!.color).toEqual(LIGHTER);
  });

  test("base_one_insert: channel color unaffected by slot plugin having its own 0x80", async () => {
    // Critical regression: 0x80 fires twice on this fixture (channel + EQ plugin).
    // The walker must attribute only the channel-scope 0x80 to the channel.
    const channels = await channelsOf("base_one_insert.flp");
    expect(channels.length).toBe(1);
    expect(channels[0]!.color).toEqual(DEFAULT);
  });
});

describe("unpackRGBA — uint32 LE layout [R, G, B, A]", () => {
  test("0x00484541 decodes to FL's default gray", () => {
    expect(unpackRGBA(0x00484541)).toEqual({ r: 0x41, g: 0x45, b: 0x48, a: 0 });
  });
  test("0xFF006400 maps to {r: 0, g: 100, b: 0, a: 255}", () => {
    expect(unpackRGBA(0xff006400)).toEqual({ r: 0, g: 0x64, b: 0, a: 0xff });
  });
  test("all-zeros and all-ones edge values", () => {
    expect(unpackRGBA(0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(unpackRGBA(0xffffffff)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });
});

describe("Channel Levels (opcode 0xDB, 24-byte struct)", () => {
  const DEFAULT_LEVELS = {
    pan: 6400,
    volume: 10000,
    pitch_shift: 0,
    filter_mod_x: 256,
    filter_mod_y: 0,
    filter_type: 0,
  };

  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
  ])("%s: every channel has default Levels", async (name) => {
    const channels = await channelsOf(name);
    for (const ch of channels) {
      expect(ch.levels).toEqual(DEFAULT_LEVELS);
    }
  });

  test("decodeLevels: crafted payload round-trips via DataView", () => {
    const buf = new Uint8Array(24);
    const view = new DataView(buf.buffer);
    view.setInt32(0, -3200, true);     // pan (sign-ed)
    view.setUint32(4, 9000, true);     // volume
    view.setInt32(8, 256, true);       // pitch_shift
    view.setUint32(12, 100, true);
    view.setUint32(16, 200, true);
    view.setUint32(20, 3, true);

    expect(decodeLevels(buf)).toEqual({
      pan: -3200,
      volume: 9000,
      pitch_shift: 256,
      filter_mod_x: 100,
      filter_mod_y: 200,
      filter_type: 3,
    });
  });

  test("decodeLevels: payload < 24 bytes yields undefined", () => {
    expect(decodeLevels(new Uint8Array(23))).toBeUndefined();
    expect(decodeLevels(new Uint8Array(0))).toBeUndefined();
  });

  test("filterTypeName: full 0..7 mapping + unknown fallback", () => {
    expect(filterTypeName(0)).toBe("FastLP");
    expect(filterTypeName(1)).toBe("LP");
    expect(filterTypeName(2)).toBe("BP");
    expect(filterTypeName(3)).toBe("HP");
    expect(filterTypeName(4)).toBe("BS");
    expect(filterTypeName(5)).toBe("LPx2");
    expect(filterTypeName(6)).toBe("SVFLP");
    expect(filterTypeName(7)).toBe("SVFLPx2");
    expect(filterTypeName(8)).toBe("unknown");
    expect(filterTypeName(-1)).toBe("unknown");
  });
});

describe("Channel BYTE flags — enabled / pingPongLoop / locked / zipped", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
  ])("%s: every channel enabled, not ping-pong, not locked, not zipped", async (name) => {
    const channels = await channelsOf(name);
    for (const ch of channels) {
      expect(ch.enabled).toBe(true);
      expect(ch.pingPongLoop).toBe(false);
      expect(ch.locked).toBe(false);
      // `zipped` is only emitted by FL when a channel is collapsed;
      // none of the 5 public fixtures has a zipped channel, so the
      // field is `undefined` (≡ false).
      expect(ch.zipped ?? false).toBe(false);
    }
  });
});

describe("channel iids are contiguous and sequential", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
  ])("%s: iids run 0..n-1", async (name) => {
    const channels = await channelsOf(name);
    for (let i = 0; i < channels.length; i++) {
      expect(channels[i]!.iid).toBe(i);
    }
  });
});
