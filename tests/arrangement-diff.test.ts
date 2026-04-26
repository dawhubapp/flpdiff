import { test, expect, describe } from "bun:test";
import {
  fmtBeats,
  compareTrack,
  compareArrangement,
  comparePattern,
  compareProjects,
  compareProjectsJson,
  parseFLPFile,
  type FlpInfoJson,
  type Match,
} from "../src/index.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type TrackJson = FlpInfoJson["arrangements"][number]["tracks"][number];
type ArrJson = FlpInfoJson["arrangements"][number];
type PatternJson = FlpInfoJson["patterns"][number];
type ClipJson = TrackJson["items"][number];

function track(overrides: Partial<TrackJson> = {}): TrackJson {
  return {
    _type: "Track",
    index: 0,
    name: null,
    color: null,
    height: 1.0,
    muted: false,
    items: [],
    ...overrides,
  };
}

function clip(overrides: Partial<ClipJson> = {}): ClipJson {
  return {
    _type: "PlaylistItem",
    position: 0,
    length: 96,
    pattern_iid: null,
    channel_iid: null,
    muted: false,
    ...overrides,
  };
}

function arr(overrides: Partial<ArrJson> = {}): ArrJson {
  return {
    _type: "Arrangement",
    index: 0,
    name: null,
    tracks: [],
    timemarkers: [],
    ...overrides,
  };
}

function pat(overrides: Partial<PatternJson> = {}): PatternJson {
  return {
    _type: "Pattern",
    iid: 0,
    name: null,
    color: null,
    length: null,
    looped: false,
    notes: [],
    controllers: [],
    ...overrides,
  };
}

describe("fmtBeats", () => {
  test("integer beats", () => {
    expect(fmtBeats(96, 96)).toBe("1");
    expect(fmtBeats(0, 96)).toBe("0");
    expect(fmtBeats(192, 96)).toBe("2");
  });

  test("fractional beats trimmed trailing zeros", () => {
    expect(fmtBeats(48, 96)).toBe("0.5");
    expect(fmtBeats(72, 96)).toBe("0.75");
  });

  test("3-decimal cap + trim trailing zeros", () => {
    // 62.01 * 96 = 5952.96 ... test 5954 ticks at ppq=96 -> 62.020833...
    expect(fmtBeats(5954, 96)).toBe("62.021");
  });
});

describe("compareTrack", () => {
  const empty = new Map();
  function matched(o: TrackJson, n: TrackJson): Match<TrackJson> {
    return { old: o, new: n, confidence: "exact" };
  }

  test("added track", () => {
    const td = compareTrack({ old: null, new: track({ index: 3, name: "Bass" }), confidence: "unmatched" }, empty, empty, 96);
    expect(td.kind).toBe("added");
    expect(td.humanLabel).toBe("Added track 'Bass'");
  });

  test("removed track (unnamed uses #index)", () => {
    const td = compareTrack({ old: track({ index: 5, name: null }), new: null, confidence: "unmatched" }, empty, empty, 96);
    expect(td.humanLabel).toBe("Removed track '#5'");
  });

  test("rename label", () => {
    const td = compareTrack(matched(track({ index: 0, name: "A" }), track({ index: 0, name: "B" })), empty, empty, 96);
    expect(td.humanLabel).toBe("Track 'a' modified (1 changes)");
    expect(td.changes[0]!.humanLabel).toBe("Track renamed from 'A' to 'B'");
  });

  test("muted toggle", () => {
    const td = compareTrack(
      matched(track({ index: 0, name: "Drums", muted: false }), track({ index: 0, name: "Drums", muted: true })),
      empty,
      empty,
      96,
    );
    expect(td.changes[0]!.humanLabel).toBe("Track muted");
  });
});

describe("clip collapse — bulk group (≥3 added with same length/ref/muted)", () => {
  test("3 clips of same ref + length collapse to one group", () => {
    const emptyCh = new Map();
    const emptyP = new Map();
    const oldT = track({ index: 0, name: "T1", items: [] });
    const newT = track({
      index: 0,
      name: "T1",
      items: [
        clip({ position: 0, length: 96, channel_iid: 1 }),
        clip({ position: 96, length: 96, channel_iid: 1 }),
        clip({ position: 192, length: 96, channel_iid: 1 }),
      ],
    });
    const td = compareTrack(
      { old: oldT, new: newT, confidence: "exact" },
      emptyCh,
      emptyP,
      96,
    );
    expect(td.clipBulkGroups.length).toBe(1);
    expect(td.clipBulkGroups[0]!.count).toBe(3);
    expect(td.clipBulkGroups[0]!.humanLabel).toBe(
      "3 clips of #1 added (length 1 beats, beats 0, 1, 2)",
    );
  });

  test("2 clips don't collapse (below threshold)", () => {
    const emptyCh = new Map();
    const emptyP = new Map();
    const oldT = track({ index: 0, items: [] });
    const newT = track({
      index: 0,
      items: [
        clip({ position: 0, length: 96, channel_iid: 1 }),
        clip({ position: 96, length: 96, channel_iid: 1 }),
      ],
    });
    const td = compareTrack(
      { old: oldT, new: newT, confidence: "exact" },
      emptyCh,
      emptyP,
      96,
    );
    expect(td.clipBulkGroups.length).toBe(0);
    // Still have individual added changes.
    expect(td.changes.length).toBe(2);
  });
});

describe("clip collapse — move group", () => {
  test("3 clips shifted by same delta collapse to one move group", () => {
    const emptyCh = new Map();
    const emptyP = new Map();
    const oldItems = [
      clip({ position: 0, length: 96, channel_iid: 1 }),
      clip({ position: 96, length: 96, channel_iid: 1 }),
      clip({ position: 192, length: 96, channel_iid: 1 }),
    ];
    const newItems = [
      clip({ position: 48, length: 96, channel_iid: 1 }),
      clip({ position: 144, length: 96, channel_iid: 1 }),
      clip({ position: 240, length: 96, channel_iid: 1 }),
    ];
    const td = compareTrack(
      { old: track({ index: 0, items: oldItems }), new: track({ index: 0, items: newItems }), confidence: "exact" },
      emptyCh,
      emptyP,
      96,
    );
    expect(td.clipMoveGroups.length).toBe(1);
    expect(td.clipMoveGroups[0]!.count).toBe(3);
    expect(td.clipMoveGroups[0]!.deltaTicks).toBe(48);
    expect(td.clipMoveGroups[0]!.humanLabel).toBe(
      "3 clips of #1 moved 1/2 beat later (beat 0→0.5, 1→1.5, 2→2.5)",
    );
  });
});

describe("clip collapse — modify group (same-position length change)", () => {
  test("3 same-length-change clips collapse to one modify group", () => {
    const emptyCh = new Map();
    const emptyP = new Map();
    const oldItems = [
      clip({ position: 0, length: 48, channel_iid: 1 }),
      clip({ position: 96, length: 48, channel_iid: 1 }),
      clip({ position: 192, length: 48, channel_iid: 1 }),
    ];
    const newItems = [
      clip({ position: 0, length: 96, channel_iid: 1 }),
      clip({ position: 96, length: 96, channel_iid: 1 }),
      clip({ position: 192, length: 96, channel_iid: 1 }),
    ];
    const td = compareTrack(
      { old: track({ index: 0, items: oldItems }), new: track({ index: 0, items: newItems }), confidence: "exact" },
      emptyCh,
      emptyP,
      96,
    );
    expect(td.clipModifyGroups.length).toBe(1);
    expect(td.clipModifyGroups[0]!.humanLabel).toBe(
      "3 clips of #1 modified (length 0.5 → 1 beats, beats 0, 1, 2)",
    );
  });
});

describe("compareArrangement", () => {
  test("unchanged arrangement with all tracks unchanged", () => {
    const a = arr({ index: 0, name: "Main", tracks: [] });
    const d = compareArrangement({ old: a, new: a, confidence: "exact" }, new Map(), new Map(), 96);
    expect(d.humanLabel).toBe("Arrangement 'main' unchanged");
  });

  test("added arrangement", () => {
    const d = compareArrangement(
      { old: null, new: arr({ index: 1, name: "Extra" }), confidence: "unmatched" },
      new Map(),
      new Map(),
      96,
    );
    expect(d.humanLabel).toBe("Added arrangement 'Extra'");
  });
});

describe("comparePattern", () => {
  test("added pattern shows note count", () => {
    const pd = comparePattern(
      { old: null, new: pat({ iid: 2, name: "Verse", notes: Array(12).fill(0).map(() => ({ _type: "Note", position: 0, length: 48, key: 60, channel_iid: 1, pan: 64, velocity: 100, fine_pitch: 120, release: 64 })) }), confidence: "unmatched" },
      96,
    );
    expect(pd.humanLabel).toBe("Added pattern 'Verse' (12 notes)");
  });

  test("rename", () => {
    const pd = comparePattern(
      {
        old: pat({ iid: 0, name: "A" }),
        new: pat({ iid: 0, name: "B" }),
        confidence: "exact",
      },
      96,
    );
    expect(pd.humanLabel).toBe("Pattern 'a' modified (1 changes)");
    expect(pd.changes[0]!.humanLabel).toBe("Pattern renamed from 'A' to 'B'");
  });
});

describe("compareProjects — full orchestrator against real corpus pair", () => {
  test("dorn-girls.flp ↔ dorn-girls_2.flp produces Python-equivalent summary", () => {
    const corpusDir = resolve(import.meta.dir, "./corpus/local/diff_pairs");
    let a, b;
    try {
      a = parseFLPFile(readFileSync(resolve(corpusDir, "dorn-girls.flp")).buffer);
      b = parseFLPFile(readFileSync(resolve(corpusDir, "dorn-girls_2.flp")).buffer);
    } catch {
      // Local corpus not available in CI; skip.
      return;
    }
    const r = compareProjects(a, b);
    // Summary shape matches Python's:
    //   "4 changes (2 channels, 1 mixer, 1 arrangements, 3 tracks)"
    expect(r.summary.humanLabel).toBe("4 changes (2 channels, 1 mixer, 1 arrangements, 3 tracks)");
    expect(r.summary.totalChanges).toBe(4);
    expect(r.summary.channelChanges).toBe(2);
    expect(r.summary.mixerChanges).toBe(1);
    expect(r.summary.arrangementChanges).toBe(1);
    expect(r.summary.trackChanges).toBe(3);
  });
});
