import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, decodeNotes, type Note } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

async function patternsOf(name: string) {
  return parseFLPFile(await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer()).patterns;
}

describe("Pattern notes (opcode 0xE0) — oracle parity", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_serum.flp",
  ])("%s: no patterns, no notes to parse", async (name) => {
    const patterns = await patternsOf(name);
    expect(patterns.length).toBe(0);
  });

  test("base_one_pattern.flp: single note (909 Kick trigger on channel 1)", async () => {
    const patterns = await patternsOf("base_one_pattern.flp");
    expect(patterns.length).toBe(1);
    const pattern = patterns[0]!;
    expect(pattern.name).toBe("P1");
    expect(pattern.notes.length).toBe(1);

    // Values cross-checked against Python flp-info's Note dict:
    //   channel_iid: 1, key: 63, position: 0, length: 48,
    //   velocity: 100, pan: 64, release: 64, fine_pitch: 120
    const note = pattern.notes[0]!;
    expect(note).toEqual({
      position: 0,
      flags: 0x4000,
      channel_iid: 1,
      length: 48,
      key: 63,
      group: 0,
      fine_pitch: 120,
      release: 64,
      midi_channel: 0,
      pan: 64,
      velocity: 100,
      mod_x: 128,
      mod_y: 128,
    });
  });
});

describe("decodeNotes — binary-format unit tests", () => {
  test("empty payload yields empty array", () => {
    expect(decodeNotes(new Uint8Array(0))).toEqual([]);
  });

  test("payload not a multiple of 24 bytes is rejected (empty array)", () => {
    expect(decodeNotes(new Uint8Array(23))).toEqual([]);
    expect(decodeNotes(new Uint8Array(47))).toEqual([]);
  });

  test("crafted two-note payload decodes to two Notes in stream order", () => {
    const buf = new Uint8Array(48);
    const view = new DataView(buf.buffer);
    // Note 0: position=96, channel_iid=0, length=24, key=60
    view.setUint32(0, 96, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, 24, true);
    view.setUint16(12, 60, true);
    // Note 1: position=192, channel_iid=1, length=48, key=67
    view.setUint32(24, 192, true);
    view.setUint16(28, 0, true);
    view.setUint16(30, 1, true);
    view.setUint32(32, 48, true);
    view.setUint16(36, 67, true);

    const notes = decodeNotes(buf);
    expect(notes.length).toBe(2);
    expect(notes[0]!.position).toBe(96);
    expect(notes[0]!.channel_iid).toBe(0);
    expect(notes[0]!.length).toBe(24);
    expect(notes[0]!.key).toBe(60);
    expect(notes[1]!.position).toBe(192);
    expect(notes[1]!.channel_iid).toBe(1);
    expect(notes[1]!.length).toBe(48);
    expect(notes[1]!.key).toBe(67);
  });
});

describe("Notes are attributed to the right pattern (dedup coexistence)", () => {
  test("base_one_pattern: the 0x41 'fires twice' rule doesn't duplicate notes", async () => {
    // The pattern-identity marker (0x41) fires twice per pattern;
    // 0xE0 (notes) appears once. If the walker's pattern-id
    // tracking is right, notes should land in a single pattern with
    // no duplicates.
    const patterns = await patternsOf("base_one_pattern.flp");
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.notes.length).toBe(1);
  });
});
