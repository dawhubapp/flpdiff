import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseFLPFile,
  formatArrangementSummary,
  decodeClips,
  decodeTimeMarkerPosition,
  type Arrangement,
} from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");

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
    expect(arrangements[0]!.tracks.length).toBe(500);
  });
});

describe("formatArrangementSummary", () => {
  const fakeTracks = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i }));
  test("1 arrangement with 500 tracks", () => {
    const arr: Arrangement[] = [{ id: 0, name: "Main", tracks: fakeTracks(500), clips: [], timemarkers: [] }];
    expect(formatArrangementSummary(arr)).toBe("1 arrangement (500 tracks)");
  });

  test("2 arrangements each with 500 tracks", () => {
    const arr: Arrangement[] = [
      { id: 0, tracks: fakeTracks(500), clips: [], timemarkers: [] },
      { id: 1, tracks: fakeTracks(500), clips: [], timemarkers: [] },
    ];
    expect(formatArrangementSummary(arr)).toBe("2 arrangements (500 + 500 tracks)");
  });

  test("empty list", () => {
    expect(formatArrangementSummary([])).toBe("0 arrangements");
  });
});

describe("Clip decoding — no fixture yet has 0xE9, so all five report empty clips[]", () => {
  test.each(ALL_FIXTURES)("%s: arrangement[0].clips is an empty array", async (name) => {
    const [arrangement] = await insertsOfViaArr(name);
    expect(arrangement).toBeDefined();
    expect(arrangement!.clips).toEqual([]);
  });

  async function insertsOfViaArr(name: string): Promise<Arrangement[]> {
    const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
    return parseFLPFile(buf).arrangements;
  }
});

describe("TimeMarkers — no fixture emits any, so all arrangements report []", () => {
  test.each(ALL_FIXTURES)("%s: arrangement[0].timemarkers is []", async (name) => {
    const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
    const arrangement = parseFLPFile(buf).arrangements[0]!;
    expect(arrangement.timemarkers).toEqual([]);
  });
});

describe("decodeTimeMarkerPosition — SIGNATURE_BIT split", () => {
  test("plain marker (no high bit)", () => {
    expect(decodeTimeMarkerPosition(96)).toEqual({ kind: "marker", position: 96 });
  });
  test("signature marker (0x08000000 set)", () => {
    expect(decodeTimeMarkerPosition(0x08000000 | 192)).toEqual({
      kind: "signature",
      position: 192,
    });
  });
  test("zero raw = plain marker at position 0", () => {
    expect(decodeTimeMarkerPosition(0)).toEqual({ kind: "marker", position: 0 });
  });
});

describe("decodeClips — binary-format unit tests (crafted payloads)", () => {
  test("empty payload yields empty array", () => {
    expect(decodeClips(new Uint8Array(0))).toEqual([]);
  });

  test("payload size not a multiple of 60 or 32 → empty array", () => {
    expect(decodeClips(new Uint8Array(37))).toEqual([]);
    expect(decodeClips(new Uint8Array(59))).toEqual([]);
  });

  test("60-byte record (FL 21+) decodes all core fields", () => {
    const buf = new Uint8Array(60);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 96, true); // position = 96 ticks
    view.setUint16(4, 20480, true); // pattern_base (ignored)
    view.setUint16(6, 3, true); // item_index
    view.setUint32(8, 192, true); // length = 192 ticks
    view.setUint16(12, 499, true); // track_rvidx (= track 0 in display order)
    view.setUint16(14, 7, true); // group
    view.setUint16(18, 64, true); // item_flags
    view.setFloat32(24, 0.25, true); // start_offset
    view.setFloat32(28, 1.75, true); // end_offset

    const clips = decodeClips(buf);
    expect(clips.length).toBe(1);
    expect(clips[0]).toEqual({
      position: 96,
      item_index: 3,
      length: 192,
      track_rvidx: 499,
      group: 7,
      item_flags: 64,
      start_offset: 0.25,
      end_offset: 1.75,
    });
  });

  test("two 60-byte records decode in order", () => {
    const buf = new Uint8Array(120);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0, true);
    view.setUint32(60, 480, true);
    const clips = decodeClips(buf);
    expect(clips.length).toBe(2);
    expect(clips[0]!.position).toBe(0);
    expect(clips[1]!.position).toBe(480);
  });
});
