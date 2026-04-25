import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseFLPFile,
  countChannelsByKind,
  formatChannelSummary,
  formatSampleSummary,
  sampleFilename,
  type Channel,
} from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

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
