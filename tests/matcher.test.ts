import { test, expect, describe } from "bun:test";
import {
  matchChannels,
  matchPatterns,
  matchMixerInserts,
  matchTracks,
  matchArrangements,
  matchProjects,
  isMatched,
  isAdded,
  isRemoved,
  type Match,
} from "../src/index.ts";
import type { Channel } from "../src/model/channel.ts";
import type { Pattern } from "../src/model/pattern.ts";
import type { MixerInsert } from "../src/model/mixer-insert.ts";
import type { Track, Arrangement } from "../src/model/arrangement.ts";
import type { FLPProject } from "../src/parser/flp-project.ts";

/**
 * Mirrors the Python test suite at `tests/test_matcher.py`. Same cases,
 * same expected outcomes — if these go green here AND Python's test
 * suite stays green, the matcher is byte-level equivalent.
 */

// Tiny constructors that keep the expected-shape minimal for tests.
function ch(iid: number, kind: Channel["kind"], name?: string): Channel {
  return { iid, kind, ...(name !== undefined ? { name } : {}) };
}
function pat(id: number, name?: string): Pattern {
  return { id, notes: [], controllers: [], ...(name !== undefined ? { name } : {}) };
}
function ins(index: number, name?: string): MixerInsert {
  return { index, slots: [], ...(name !== undefined ? { name } : {}) };
}
function track(index: number, name?: string): Track {
  return { index, ...(name !== undefined ? { name } : {}) };
}
function arr(id: number, name?: string): Arrangement {
  return {
    id,
    tracks: [],
    clips: [],
    timemarkers: [],
    ...(name !== undefined ? { name } : {}),
  };
}

describe("matchChannels", () => {
  test("pairs by iid (exact)", () => {
    const a = [ch(0, "sampler", "Kick")];
    const b = [ch(0, "sampler", "Kick (renamed)")];
    const ms = matchChannels(a, b);
    expect(ms.length).toBe(1);
    expect(ms[0]!.confidence).toBe("exact");
    expect(isMatched(ms[0]!)).toBe(true);
    expect(ms[0]!.old).toBe(a[0]!);
    expect(ms[0]!.new).toBe(b[0]!);
  });

  test("falls back to (kind, name)", () => {
    const a = [ch(0, "sampler", "Kick")];
    const b = [ch(5, "sampler", "Kick")];
    const ms = matchChannels(a, b);
    expect(ms.length).toBe(1);
    expect(ms[0]!.confidence).toBe("name");
    expect(isMatched(ms[0]!)).toBe(true);
  });

  test("does NOT pair different kinds with same name", () => {
    const a = [ch(0, "sampler", "Lead")];
    const b = [ch(5, "instrument", "Lead")];
    const ms = matchChannels(a, b);
    expect(ms.length).toBe(2);
    const removed = ms.filter(isRemoved);
    const added = ms.filter(isAdded);
    expect(removed.length).toBe(1);
    expect(removed[0]!.old).toBe(a[0]!);
    expect(added.length).toBe(1);
    expect(added[0]!.new).toBe(b[0]!);
  });

  test("unnamed channel cannot fall back", () => {
    const a = [ch(0, "sampler")];
    const b = [ch(5, "sampler")];
    const ms = matchChannels(a, b);
    expect(ms.length).toBe(2);
    expect(ms.filter(isRemoved).length).toBe(1);
    expect(ms.filter(isAdded).length).toBe(1);
  });

  test("deterministic order: exact → name → removed → added", () => {
    const a = [
      ch(1, "sampler", "A"), // exact with b[0]
      ch(2, "sampler", "B"), // name with b[2]
      ch(3, "sampler", "C"), // removed
    ];
    const b = [
      ch(1, "sampler", "A renamed"), // exact with a[0]
      ch(99, "sampler", "D"), // added
      ch(7, "sampler", "B"), // name with a[1]
    ];
    const ms = matchChannels(a, b);
    expect(ms.length).toBe(4);
    // Exact
    expect(ms[0]!.confidence).toBe("exact");
    expect(ms[0]!.old).toBe(a[0]!);
    expect(ms[0]!.new).toBe(b[0]!);
    // Name
    expect(ms[1]!.confidence).toBe("name");
    expect(ms[1]!.old).toBe(a[1]!);
    expect(ms[1]!.new).toBe(b[2]!);
    // Removed
    expect(isRemoved(ms[2]!)).toBe(true);
    expect(ms[2]!.old).toBe(a[2]!);
    // Added
    expect(isAdded(ms[3]!)).toBe(true);
    expect(ms[3]!.new).toBe(b[1]!);
  });

  test("handles empty sides", () => {
    expect(matchChannels([], [])).toEqual([]);
    const a = [ch(0, "sampler", "X")];
    const removedOnly = matchChannels(a, []);
    expect(removedOnly.length).toBe(1);
    expect(isRemoved(removedOnly[0]!)).toBe(true);
    const addedOnly = matchChannels([], a);
    expect(addedOnly.length).toBe(1);
    expect(isAdded(addedOnly[0]!)).toBe(true);
  });
});

describe("matchPatterns", () => {
  test("pairs by id, then name", () => {
    const a = [pat(0, "Verse"), pat(1, "Chorus")];
    const b = [pat(0, "Verse v2"), pat(9, "Chorus")];
    const ms = matchPatterns(a, b);
    expect(ms.length).toBe(2);
    expect(ms[0]!.confidence).toBe("exact");
    expect(ms[1]!.confidence).toBe("name");
  });
});

describe("matchMixerInserts", () => {
  test("pairs by index, then name", () => {
    const a = [ins(0, "Master"), ins(1, "Drums")];
    const b = [ins(0, "Master"), ins(5, "Drums")];
    const ms = matchMixerInserts(a, b);
    expect(ms[0]!.confidence).toBe("exact");
    expect(ms[1]!.confidence).toBe("name");
  });

  test("unnamed inserts fall through to unmatched", () => {
    const a = [ins(4)];
    const b = [ins(9)];
    const ms = matchMixerInserts(a, b);
    expect(ms.length).toBe(2);
    expect(ms.filter(isRemoved).length).toBe(1);
    expect(ms.filter(isAdded).length).toBe(1);
  });
});

describe("matchTracks", () => {
  test("pairs by index, then name", () => {
    const a = [track(0, "Drums"), track(1, "Bass")];
    const b = [track(0, "Drums"), track(7, "Bass")];
    const ms = matchTracks(a, b);
    expect(ms[0]!.confidence).toBe("exact");
    expect(ms[1]!.confidence).toBe("name");
  });
});

describe("matchArrangements", () => {
  test("pairs by id, then name", () => {
    const a = [arr(0, "Main"), arr(1, "Alt")];
    const b = [arr(0, "Main renamed"), arr(7, "Alt")];
    const ms = matchArrangements(a, b);
    expect(ms[0]!.confidence).toBe("exact");
    expect(ms[1]!.confidence).toBe("name");
  });
});

describe("matchProjects", () => {
  test("runs every per-entity matcher", () => {
    const proj = (
      channels: Channel[],
      patterns: Pattern[],
      inserts: MixerInsert[],
      arrangements: Arrangement[],
    ): FLPProject => ({
      header: { format: 0, n_channels: 0, ppq: 96 },
      events: [],
      metadata: {},
      channels,
      inserts,
      patterns,
      arrangements,
      insertRouting: [],
    });
    const a = proj([ch(0, "sampler", "X")], [pat(0, "P")], [ins(0)], [arr(0)]);
    const b = proj([ch(0, "sampler", "X")], [pat(0, "P")], [ins(0)], [arr(0)]);
    const m = matchProjects(a, b);
    expect(m.channels.length).toBe(1);
    expect(m.patterns.length).toBe(1);
    expect(m.mixerInserts.length).toBe(1);
    expect(m.arrangements.length).toBe(1);
    for (const ms of [m.channels, m.patterns, m.mixerInserts, m.arrangements]) {
      expect(ms[0]!.confidence).toBe("exact");
    }
  });
});

describe("Match type-guard helpers", () => {
  test("correctly narrow on isMatched / isAdded / isRemoved", () => {
    const matched: Match<Channel> = { old: ch(0, "sampler"), new: ch(0, "sampler"), confidence: "exact" };
    const added: Match<Channel> = { old: null, new: ch(0, "sampler"), confidence: "unmatched" };
    const removed: Match<Channel> = { old: ch(0, "sampler"), new: null, confidence: "unmatched" };
    expect(isMatched(matched)).toBe(true);
    expect(isMatched(added)).toBe(false);
    expect(isMatched(removed)).toBe(false);
    expect(isAdded(added)).toBe(true);
    expect(isRemoved(removed)).toBe(true);
  });
});
