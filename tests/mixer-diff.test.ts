import { test, expect, describe } from "bun:test";
import {
  compareMixerInsert,
  compareMixerFromJson,
  type FlpInfoJson,
  type Match,
} from "../src/index.ts";

/**
 * Mixer diff parity tests — labels cross-checked against Python's
 * compare_mixer_insert. See commit message for exact Python outputs.
 */

type InsertJson = FlpInfoJson["mixer"]["inserts"][number];
type SlotJson = InsertJson["slots"][number];

function slot(overrides: Partial<SlotJson> = {}): SlotJson {
  return {
    _type: "MixerSlot",
    index: 0,
    enabled: true,
    plugin: null,
    ...overrides,
  };
}

function insert(overrides: Partial<InsertJson> = {}): InsertJson {
  return {
    _type: "MixerInsert",
    index: 0,
    name: null,
    color: null,
    enabled: true,
    locked: false,
    pan: null,
    volume: null,
    stereo_separation: null,
    slots: [],
    routes_to: [],
    ...overrides,
  };
}

function pair(oldIns: InsertJson, newIns: InsertJson): Match<InsertJson> {
  return { old: oldIns, new: newIns, confidence: "exact" };
}

describe("Insert label phrasing", () => {
  test("index 0 → 'Master (name)'", () => {
    const diff = compareMixerInsert({
      old: null,
      new: insert({ index: 0, name: null }),
      confidence: "unmatched",
    });
    expect(diff.humanLabel).toBe("Added Master (unnamed)");
  });

  test("index > 0 → 'Insert N (name)'", () => {
    const diff = compareMixerInsert({
      old: null,
      new: insert({ index: 4, name: "NewBus" }),
      confidence: "unmatched",
    });
    expect(diff.humanLabel).toBe("Added Insert 4 (NewBus)");
  });

  test("unnamed insert label uses 'unnamed'", () => {
    const diff = compareMixerInsert({
      old: null,
      new: insert({ index: 3, name: null }),
      confidence: "unmatched",
    });
    expect(diff.humanLabel).toBe("Added Insert 3 (unnamed)");
  });
});

describe("Scalar insert changes — Python-matched labels", () => {
  test("rename change", () => {
    const diff = compareMixerInsert(
      pair(insert({ index: 1, name: "A" }), insert({ index: 1, name: "B" })),
    );
    expect(diff.humanLabel).toBe("Insert 1 (A) modified (1 changes)");
    expect(diff.changes[0]!.humanLabel).toBe("Insert renamed from 'A' to 'B'");
  });

  test("color + volume multi-change", () => {
    const diff = compareMixerInsert(
      pair(
        insert({
          index: 1,
          name: "Drums",
          color: { _type: "RGBA", red: 1, green: 0, blue: 0, alpha: 0 },
          volume: 0.5,
        }),
        insert({
          index: 1,
          name: "Drums",
          color: { _type: "RGBA", red: 0, green: 1, blue: 0, alpha: 0 },
          volume: 0.8,
        }),
      ),
    );
    expect(diff.humanLabel).toBe("Insert 1 (Drums) modified (2 changes)");
    const labels = diff.changes.map((c) => c.humanLabel);
    expect(labels).toContain("Insert color: #ff0000 → #00ff00");
    expect(labels).toContain("Insert volume 50% → 80%");
  });

  test("routes_to change → 'Insert routing changed: [] → [0, 2]'", () => {
    const diff = compareMixerInsert(
      pair(
        insert({ index: 3, name: "Aux", routes_to: [] }),
        insert({ index: 3, name: "Aux", routes_to: [0, 2] }),
      ),
    );
    expect(diff.changes[0]!.humanLabel).toBe("Insert routing changed: [] → [0, 2]");
  });

  test("locked toggle", () => {
    const diff = compareMixerInsert(
      pair(insert({ index: 1, locked: false }), insert({ index: 1, locked: true })),
    );
    expect(diff.changes[0]!.humanLabel).toBe("Insert locked");
  });
});

describe("Slot diff", () => {
  test("slot enabled → bypassed", () => {
    const diff = compareMixerInsert(
      pair(
        insert({
          index: 1,
          slots: [slot({ index: 0, enabled: true }), slot({ index: 1, enabled: true })],
        }),
        insert({
          index: 1,
          slots: [slot({ index: 0, enabled: true }), slot({ index: 1, enabled: false })],
        }),
      ),
    );
    expect(diff.humanLabel).toBe("Insert 1 (unnamed) modified (1 changes)");
    expect(diff.changes[0]!.humanLabel).toBe("Slot 1 bypassed");
  });

  test("plugin swap in slot carries the slot hint", () => {
    const pluginOld = { _type: "Plugin" as const, name: "Fruity EQ 2", vendor: null, is_vst: false, state: null };
    const pluginNew = { _type: "Plugin" as const, name: "Sytrus", vendor: null, is_vst: false, state: null };
    const diff = compareMixerInsert(
      pair(
        insert({
          index: 5,
          slots: [slot({ index: 0 }), slot({ index: 1 }), slot({ index: 2, plugin: pluginOld })],
        }),
        insert({
          index: 5,
          slots: [slot({ index: 0 }), slot({ index: 1 }), slot({ index: 2, plugin: pluginNew })],
        }),
      ),
    );
    expect(diff.changes[0]!.humanLabel).toBe("Plugin swapped in slot 2: Fruity EQ 2 → Sytrus");
  });
});

describe("compareMixerFromJson — orchestrator", () => {
  test("no changes → empty mixer diff", () => {
    const a = [insert({ index: 0, name: "Master" }), insert({ index: 1, name: "Drums" })];
    const d = compareMixerFromJson(a, a);
    expect(d.inserts).toEqual([]);
  });

  test("only changed inserts survive", () => {
    const d = compareMixerFromJson(
      [insert({ index: 0, name: "Master" }), insert({ index: 1, name: "Drums" })],
      [insert({ index: 0, name: "Master" }), insert({ index: 1, name: "Drums Renamed" })],
    );
    expect(d.inserts.length).toBe(1);
    expect(d.inserts[0]!.index).toBe(1);
  });

  test("added inserts appear", () => {
    const d = compareMixerFromJson(
      [insert({ index: 0 })],
      [insert({ index: 0 }), insert({ index: 1, name: "New" })],
    );
    expect(d.inserts.length).toBe(1);
    expect(d.inserts[0]!.kind).toBe("added");
  });
});
