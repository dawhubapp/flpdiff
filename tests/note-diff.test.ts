import { test, expect, describe } from "bun:test";
import {
  describePositionDelta,
  notePitchLabel,
  diffNotes,
  type FlpInfoJson,
} from "../src/index.ts";

/**
 * Port of Python's tests/test_note_diff.py. Same cases, same expected
 * labels. If these stay green AND the Python suite stays green, the
 * note diff is byte-equivalent.
 */

type NoteJson = FlpInfoJson["patterns"][number]["notes"][number];

function note(overrides: Partial<NoteJson> = {}): NoteJson {
  return {
    _type: "Note",
    position: 0,
    length: 48,
    key: 60,
    channel_iid: 0,
    pan: 64,
    velocity: 100,
    fine_pitch: 120,
    release: 64,
    ...overrides,
  };
}

describe("describePositionDelta — matches Python byte-for-byte", () => {
  test("zero delta", () => {
    expect(describePositionDelta(0, 96)).toBe("no move");
  });

  test("whole-beat shifts (plural/singular)", () => {
    expect(describePositionDelta(96, 96)).toBe("1 beat later");
    expect(describePositionDelta(192, 96)).toBe("2 beats later");
    expect(describePositionDelta(-96, 96)).toBe("1 beat earlier");
  });

  test("fractional subdivisions", () => {
    expect(describePositionDelta(48, 96)).toBe("1/2 beat later");
    expect(describePositionDelta(24, 96)).toBe("1/4 beat later");
    expect(describePositionDelta(12, 96)).toBe("1/8 beat later");
    expect(describePositionDelta(6, 96)).toBe("1/16 beat later");
    expect(describePositionDelta(3, 96)).toBe("1/32 beat later");
  });

  test("fractional multi-units", () => {
    // 3/16 beat later = 18 ticks at ppq=96
    expect(describePositionDelta(18, 96)).toBe("3/16 beat later");
  });

  test("non-aligned shift falls back to raw ticks", () => {
    expect(describePositionDelta(7, 96)).toBe("7 ticks later");
    expect(describePositionDelta(-1, 96)).toBe("1 tick earlier");
    expect(describePositionDelta(5, 96)).toBe("5 ticks later");
  });
});

describe("notePitchLabel — FL convention (C5 = MIDI 60)", () => {
  test("notable values", () => {
    expect(notePitchLabel(60)).toBe("C5");
    expect(notePitchLabel(48)).toBe("C4");
    expect(notePitchLabel(63)).toBe("D#5");
    expect(notePitchLabel(57)).toBe("A4");
    expect(notePitchLabel(72)).toBe("C6");
  });
});

describe("diffNotes — three-pass matching", () => {
  test("identical collections → empty result", () => {
    const n = note({ position: 0, key: 60, channel_iid: 1 });
    expect(diffNotes([n], [n], 96)).toEqual([]);
  });

  test("add + remove on empty sides", () => {
    expect(diffNotes([note()], [], 96)).toHaveLength(1);
    expect(diffNotes([], [note()], 96)).toHaveLength(1);
    expect(diffNotes([note()], [], 96)[0]!.kind).toBe("removed");
    expect(diffNotes([], [note()], 96)[0]!.kind).toBe("added");
  });

  test("exact match with modified velocity", () => {
    const old = note({ position: 0, key: 60, velocity: 100 });
    const nw = note({ position: 0, key: 60, velocity: 80 });
    const changes = diffNotes([old], [nw], 96);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("modified");
    expect(changes[0]!.humanLabel).toBe(
      "C5 on channel 0 at beat 0: velocity 100 → 80",
    );
  });

  test("move detected at same (channel, key), different position", () => {
    const old = note({ position: 0, key: 60, channel_iid: 1 });
    const nw = note({ position: 96, key: 60, channel_iid: 1 });
    const changes = diffNotes([old], [nw], 96);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("moved");
    expect(changes[0]!.humanLabel).toBe("C5 on channel 1 moved 1 beat later");
  });

  test("move with velocity change adds parenthesized extras", () => {
    const old = note({ position: 0, key: 60, channel_iid: 1, velocity: 100 });
    const nw = note({ position: 48, key: 60, channel_iid: 1, velocity: 80 });
    const changes = diffNotes([old], [nw], 96);
    expect(changes[0]!.humanLabel).toBe(
      "C5 on channel 1 moved 1/2 beat later (velocity 100 → 80)",
    );
  });

  test("different key surfaces as remove + add, not a move", () => {
    const old = note({ position: 0, key: 60, channel_iid: 1 });
    const nw = note({ position: 0, key: 62, channel_iid: 1 });
    const changes = diffNotes([old], [nw], 96);
    expect(changes).toHaveLength(2);
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["added", "removed"]);
  });

  test("greedy nearest-position pairing for moves", () => {
    // Two notes of same (channel, key) present on both sides at
    // different positions — pair by nearest-delta.
    const oldNotes = [
      note({ position: 0, key: 60, channel_iid: 1 }),
      note({ position: 96, key: 60, channel_iid: 1 }),
    ];
    const newNotes = [
      note({ position: 24, key: 60, channel_iid: 1 }), // should pair with old[0]
      note({ position: 120, key: 60, channel_iid: 1 }), // should pair with old[1]
    ];
    const changes = diffNotes(oldNotes, newNotes, 96);
    expect(changes).toHaveLength(2);
    for (const c of changes) expect(c.kind).toBe("moved");
  });

  test("deterministic order: modifieds → moves → removals → additions", () => {
    const oldNotes = [
      note({ position: 0, key: 60, channel_iid: 1, velocity: 100 }), // will be modified
      note({ position: 48, key: 62, channel_iid: 1 }), // will be moved
      note({ position: 96, key: 64, channel_iid: 1 }), // will be removed
    ];
    const newNotes = [
      note({ position: 0, key: 60, channel_iid: 1, velocity: 80 }), // exact-match modified
      note({ position: 96, key: 62, channel_iid: 1 }), // moved old[1]
      note({ position: 144, key: 67, channel_iid: 1 }), // new (added)
    ];
    const changes = diffNotes(oldNotes, newNotes, 96);
    const kinds = changes.map((c) => c.kind);
    expect(kinds).toEqual(["modified", "moved", "removed", "added"]);
  });

  test("length change reports musical delta suffix for clean subdivisions", () => {
    const old = note({ position: 0, key: 60, channel_iid: 1, length: 48 });
    const nw = note({ position: 0, key: 60, channel_iid: 1, length: 96 });
    const changes = diffNotes([old], [nw], 96);
    expect(changes[0]!.humanLabel).toBe(
      "C5 on channel 1 at beat 0: length 48 → 96 ticks (1/2 beat longer)",
    );
  });

  test("multiple changed fields listed comma-separated", () => {
    const old = note({ position: 0, key: 60, velocity: 100, pan: 64, release: 64 });
    const nw = note({ position: 0, key: 60, velocity: 80, pan: 50, release: 80 });
    const changes = diffNotes([old], [nw], 96);
    expect(changes[0]!.humanLabel).toBe(
      "C5 on channel 0 at beat 0: velocity 100 → 80, pan 64 → 50, release 64 → 80",
    );
  });
});
