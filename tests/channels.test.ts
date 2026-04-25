import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseFLPFile,
  countChannelsByKind,
  formatChannelSummary,
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
