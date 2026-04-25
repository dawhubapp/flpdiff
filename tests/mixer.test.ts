import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseFLPFile,
  countNamedInserts,
  countActiveSlots,
  formatMixerSummary,
  decodeMixerParams,
  type MixerInsert,
} from "../src/index.ts";

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
    expect(formatMixerSummary(inserts)).toBe("18 active inserts, 1 named, 1 effect slot");
  });

  test("other fixtures have zero named inserts", async () => {
    for (const name of ["base_one_channel.flp", "base_one_pattern.flp", "base_one_serum.flp"]) {
      const inserts = await insertsOf(name);
      expect(countNamedInserts(inserts)).toBe(0);
    }
  });
});

describe("Insert color/icon/routing defaults (0x95, 0x5F, 0x93, 0x9A)", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
  ])("%s: every insert has default color/icon/routing (undefined)", async (name) => {
    const inserts = await insertsOf(name);
    for (const ins of inserts) {
      expect(ins.color).toBeUndefined();
      expect(ins.icon).toBeUndefined();
      expect(ins.output).toBeUndefined();
      expect(ins.input).toBeUndefined();
    }
  });
});

describe("MixerParams blob (opcode 0xE1) — raw record decoder", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
  ])("%s: 0xE1 decodes to exactly (payload / 12) records", async (name) => {
    const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
    const project = parseFLPFile(buf);
    const e1 = project.events.find((e) => e.opcode === 0xe1);
    expect(e1).toBeDefined();
    if (e1!.kind !== "blob") throw new Error("unreachable");
    const records = decodeMixerParams(e1!.payload);
    expect(records.length * 12).toBe(e1!.payload.byteLength);
    // All records must have one of the documented id values.
    const validIds = new Set([0, 1, 192, 193, 194, 208, 209, 210, 216, 217, 218, 224, 225, 226]);
    // Plus the 64..191 RouteVolStart range (send-level routing).
    for (const rec of records) {
      const isRoute = rec.id >= 64 && rec.id <= 191;
      expect(validIds.has(rec.id) || isRoute).toBe(true);
    }
  });

  test("base_empty: finds SlotEnabled records for expected sparse insert indices", async () => {
    const buf = await Bun.file(resolve(CORPUS_DIR, "base_empty.flp")).arrayBuffer();
    const project = parseFLPFile(buf);
    const e1 = project.events.find((e) => e.opcode === 0xe1)!;
    if (e1.kind !== "blob") throw new Error("unreachable");
    const records = decodeMixerParams(e1.payload);

    // FL 25's insert_idx packing is sparse — records exist for indices
    // well outside the visible 0..17 range. Regression-guard that at
    // least one record has insert_idx > 50 (confirming the sparsity
    // observation and that attribution isn't a simple `== visible_idx`).
    const sparseIdx = records.filter((r) => r.insertIdx > 50);
    expect(sparseIdx.length).toBeGreaterThan(0);
  });

  test("decodeMixerParams: payload not a multiple of 12 yields empty array", () => {
    expect(decodeMixerParams(new Uint8Array(11))).toEqual([]);
    expect(decodeMixerParams(new Uint8Array(0))).toEqual([]);
  });

  test("decodeMixerParams: crafted record extracts all four fields", () => {
    const buf = new Uint8Array(12);
    const view = new DataView(buf.buffer);
    view.setUint8(4, 192); // id = Volume
    view.setUint16(6, (3 << 6) | 5, true); // insert 3, slot 5
    view.setInt32(8, 9500, true);

    expect(decodeMixerParams(buf)).toEqual([{ id: 192, insertIdx: 3, slotIdx: 5, msg: 9500 }]);
  });
});

describe("Mixer slots (opcode 0x62) — 10 slots per insert", () => {
  test.each(ALL_FIXTURES)("%s: every insert has 10 slots", async (name) => {
    const inserts = await insertsOf(name);
    for (const ins of inserts) {
      expect(ins.slots.length).toBe(10);
      // Indices should be 0..9 in order
      expect(ins.slots.map((s) => s.index)).toEqual([...Array(10).keys()]);
    }
  });
});

describe("Slot plugin names (opcode 0xCB in slot scope) — oracle parity", () => {
  test("base_one_insert.flp: insert[1].slots[0] hosts Fruity Parametric EQ 2", async () => {
    const inserts = await insertsOf("base_one_insert.flp");
    expect(countActiveSlots(inserts)).toBe(1);

    const insert1 = inserts[1]!;
    expect(insert1.slots[0]!.pluginName).toBe("Fruity Parametric EQ 2");
    // Other slots of insert 1 are empty
    for (let i = 1; i < 10; i++) {
      expect(insert1.slots[i]!.pluginName).toBeUndefined();
    }
    // Other inserts have no slot plugins
    for (let ins = 0; ins < inserts.length; ins++) {
      if (ins === 1) continue;
      for (const slot of inserts[ins]!.slots) {
        expect(slot.pluginName).toBeUndefined();
      }
    }
  });

  test("other fixtures have zero active slots", async () => {
    for (const name of ["base_empty.flp", "base_one_channel.flp", "base_one_pattern.flp", "base_one_serum.flp"]) {
      const inserts = await insertsOf(name);
      expect(countActiveSlots(inserts)).toBe(0);
    }
  });

  test("formatMixerSummary reflects active slots", async () => {
    const withEq = await insertsOf("base_one_insert.flp");
    expect(formatMixerSummary(withEq)).toBe("18 active inserts, 1 named, 1 effect slot");

    const empty = await insertsOf("base_empty.flp");
    expect(formatMixerSummary(empty)).toBe("18 active inserts");
  });
});
