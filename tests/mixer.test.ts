import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, countNamedInserts, formatMixerSummary, type MixerInsert } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

async function insertsOf(name: string): Promise<MixerInsert[]> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return parseFLPFile(buf).inserts;
}

const ALL_FIXTURES = [
  "base_empty.flp",
  "base_one_channel.flp",
  "base_one_insert.flp",
  "base_one_pattern.flp",
  "base_one_serum.flp",
];

/**
 * Oracle values from Python's `flp-info`: every FL 25 base fixture
 * reports "18 active inserts". base_one_insert.flp additionally has
 * one named insert ("Drums" at index 1) per Python's JSON output.
 */
describe("Mixer insert count — oracle parity across all 5 fixtures", () => {
  test.each(ALL_FIXTURES)("%s: 18 active inserts", async (name) => {
    const inserts = await insertsOf(name);
    expect(inserts.length).toBe(18);
    // Indices are contiguous 0..17
    expect(inserts.map((i) => i.index)).toEqual([...Array(18).keys()]);
  });
});

describe("Insert names (opcode 0xCC)", () => {
  test("base_empty.flp: no named inserts", async () => {
    const inserts = await insertsOf("base_empty.flp");
    expect(countNamedInserts(inserts)).toBe(0);
    expect(inserts.every((i) => i.name === undefined)).toBe(true);
    expect(formatMixerSummary(inserts)).toBe("18 active inserts");
  });

  test("base_one_insert.flp: insert 1 is 'Drums'", async () => {
    const inserts = await insertsOf("base_one_insert.flp");
    expect(countNamedInserts(inserts)).toBe(1);

    const named = inserts.filter((i) => i.name !== undefined);
    expect(named.length).toBe(1);
    expect(named[0]!.index).toBe(1);
    expect(named[0]!.name).toBe("Drums");
    expect(formatMixerSummary(inserts)).toBe("18 active inserts, 1 named");
  });

  test("other fixtures have zero named inserts", async () => {
    for (const name of ["base_one_channel.flp", "base_one_pattern.flp", "base_one_serum.flp"]) {
      const inserts = await insertsOf(name);
      expect(countNamedInserts(inserts)).toBe(0);
    }
  });
});
