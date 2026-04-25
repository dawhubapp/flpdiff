import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, formatArrangementSummary, type Arrangement } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

async function arrangementsOf(name: string): Promise<Arrangement[]> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return parseFLPFile(buf).arrangements;
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
 * reports "Arrangements: 1 (500 tracks, 0 clips)". The default
 * arrangement is named "Arrangement" and carries 500 track slots
 * even though only a handful might carry clips.
 */
describe("Arrangement extraction — oracle parity", () => {
  test.each(ALL_FIXTURES)("%s: 1 arrangement, 500 tracks, name='Arrangement'", async (name) => {
    const arrangements = await arrangementsOf(name);
    expect(arrangements.length).toBe(1);
    expect(arrangements[0]!.id).toBe(0);
    expect(arrangements[0]!.name).toBe("Arrangement");
    expect(arrangements[0]!.trackCount).toBe(500);
  });
});

describe("formatArrangementSummary", () => {
  test("1 arrangement with 500 tracks", () => {
    const arr: Arrangement[] = [{ id: 0, name: "Main", trackCount: 500 }];
    expect(formatArrangementSummary(arr)).toBe("1 arrangement (500 tracks)");
  });

  test("2 arrangements each with 500 tracks", () => {
    const arr: Arrangement[] = [
      { id: 0, trackCount: 500 },
      { id: 1, trackCount: 500 },
    ];
    expect(formatArrangementSummary(arr)).toBe("2 arrangements (500 + 500 tracks)");
  });

  test("empty list", () => {
    expect(formatArrangementSummary([])).toBe("0 arrangements");
  });
});
