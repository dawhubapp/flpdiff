import { test, expect, describe } from "bun:test";
import {
  makeChange,
  makeNoteChange,
  makeAutomationChange,
  makeOpaqueChange,
  makeChannelDiff,
  makePatternDiff,
  makeMixerInsertDiff,
  makeMixerDiff,
  makeClipMoveGroup,
  makeClipBulkGroup,
  makeClipModifyGroup,
  makeTrackDiff,
  makeArrangementDiff,
  makeDiffSummary,
  isMixerDiffEmpty,
  diffSummaryHasChanges,
  computeSummaryCounts,
} from "../src/index.ts";

/**
 * Validator coverage for the diff model. Mirrors Python's
 * tests/test_diff_model.py — every __post_init__ check in the Python
 * dataclasses corresponds to one of these assertions.
 */

describe("Change validator", () => {
  test("rejects empty humanLabel", () => {
    expect(() =>
      makeChange({ path: "metadata.tempo", kind: "modified", oldValue: 120, newValue: 140, humanLabel: "" }),
    ).toThrow(/non-empty humanLabel/);
  });

  test("preserves fields on a valid Change", () => {
    const c = makeChange({
      path: "metadata.tempo",
      kind: "modified",
      oldValue: 120,
      newValue: 140,
      humanLabel: "Tempo changed from 120 to 140 BPM",
    });
    expect(c.path).toBe("metadata.tempo");
    expect(c.oldValue).toBe(120);
    expect(c.newValue).toBe(140);
  });
});

describe("NoteChange / AutomationChange / OpaqueChange validators", () => {
  test("NoteChange rejects empty label", () => {
    expect(() =>
      makeNoteChange({ kind: "added", oldNote: null, newNote: {}, humanLabel: "" }),
    ).toThrow();
  });

  test("AutomationChange rejects empty label", () => {
    expect(() =>
      makeAutomationChange({ kind: "modified", oldPoint: {}, newPoint: {}, humanLabel: "" }),
    ).toThrow();
  });

  test("OpaqueChange rejects empty label", () => {
    expect(() =>
      makeOpaqueChange({
        path: "mixer.inserts[0].slots[0].plugin.state",
        locationLabel: "Insert 1 / Slot 1",
        oldSha256: "a",
        newSha256: "b",
        oldSize: 10,
        newSize: 12,
        humanLabel: "",
      }),
    ).toThrow();
  });
});

describe("Entity diff validators", () => {
  test("ChannelDiff rejects empty label", () => {
    expect(() =>
      makeChannelDiff({ identity: ["channel", 0], kind: "modified", name: "Kick", humanLabel: "" }),
    ).toThrow();
  });

  test("ChannelDiff defaults changes + automationChanges to empty lists", () => {
    const d = makeChannelDiff({
      identity: ["channel", 0],
      kind: "modified",
      name: "Kick",
      humanLabel: "Channel 'Kick' modified",
    });
    expect(d.changes).toEqual([]);
    expect(d.automationChanges).toEqual([]);
  });

  test("PatternDiff rejects empty label + defaults the three lists", () => {
    expect(() =>
      makePatternDiff({ identity: ["pattern", 0], kind: "modified", name: "P1", humanLabel: "" }),
    ).toThrow();
    const d = makePatternDiff({
      identity: ["pattern", 0],
      kind: "modified",
      name: "P1",
      humanLabel: "Pattern 'P1' modified",
    });
    expect(d.changes).toEqual([]);
    expect(d.noteChanges).toEqual([]);
    expect(d.controllerChanges).toEqual([]);
  });

  test("MixerInsertDiff + MixerDiff defaults + is_empty", () => {
    expect(() =>
      makeMixerInsertDiff({ identity: ["insert", 0], kind: "modified", index: 0, name: null, humanLabel: "" }),
    ).toThrow();
    const empty = makeMixerDiff();
    expect(isMixerDiffEmpty(empty)).toBe(true);
    const nonEmpty = makeMixerDiff({
      inserts: [
        makeMixerInsertDiff({
          identity: ["insert", 0],
          kind: "modified",
          index: 0,
          name: null,
          humanLabel: "Master modified",
        }),
      ],
    });
    expect(isMixerDiffEmpty(nonEmpty)).toBe(false);
  });
});

describe("ClipCollapseGroup validators — count invariants", () => {
  test("ClipMoveGroup requires count ≥ 2 and matching lengths", () => {
    expect(() =>
      makeClipMoveGroup({
        refLabel: "pattern 'A'",
        deltaTicks: 16,
        count: 1,
        positions: [[0, 16]],
        changePaths: ["x"],
        humanLabel: "label",
      }),
    ).toThrow(/at least 2 members/);

    expect(() =>
      makeClipMoveGroup({
        refLabel: "pattern 'A'",
        deltaTicks: 16,
        count: 2,
        positions: [[0, 16]],
        changePaths: ["x", "y"],
        humanLabel: "label",
      }),
    ).toThrow(/count must match/);

    const good = makeClipMoveGroup({
      refLabel: "pattern 'A'",
      deltaTicks: 16,
      count: 2,
      positions: [
        [0, 16],
        [32, 48],
      ],
      changePaths: ["x", "y"],
      humanLabel: "2 clips shifted +16 ticks",
    });
    expect(good.count).toBe(2);
  });

  test("ClipBulkGroup and ClipModifyGroup reject count<2", () => {
    expect(() =>
      makeClipBulkGroup({
        kind: "added",
        refLabel: "pattern 'A'",
        lengthTicks: 96,
        muted: false,
        count: 1,
        positions: [0],
        changePaths: ["x"],
        humanLabel: "label",
      }),
    ).toThrow();
    expect(() =>
      makeClipModifyGroup({
        refLabel: "pattern 'A'",
        oldLengthTicks: 96,
        newLengthTicks: 192,
        oldMuted: false,
        newMuted: false,
        count: 1,
        positions: [0],
        changePaths: ["x"],
        humanLabel: "label",
      }),
    ).toThrow();
  });
});

describe("TrackDiff + ArrangementDiff validators + defaults", () => {
  test("TrackDiff defaults all 4 change-list fields", () => {
    const t = makeTrackDiff({
      identity: ["arrangement", 0, "track", 2],
      kind: "modified",
      index: 2,
      name: "Bass",
      humanLabel: "Track 'Bass' modified",
    });
    expect(t.changes).toEqual([]);
    expect(t.clipMoveGroups).toEqual([]);
    expect(t.clipBulkGroups).toEqual([]);
    expect(t.clipModifyGroups).toEqual([]);
  });

  test("ArrangementDiff defaults changes + trackChanges", () => {
    const a = makeArrangementDiff({
      identity: ["arrangement", 0],
      kind: "modified",
      name: "Main",
      humanLabel: "Arrangement 'Main' modified",
    });
    expect(a.changes).toEqual([]);
    expect(a.trackChanges).toEqual([]);
  });
});

describe("DiffSummary + DiffResult helpers", () => {
  test("hasChanges considers totalChanges and subcounts", () => {
    const zero = makeDiffSummary({
      totalChanges: 0,
      metadataChanges: 0,
      channelChanges: 0,
      patternChanges: 0,
      mixerChanges: 0,
      arrangementChanges: 0,
      opaqueChanges: 0,
      humanLabel: "No changes",
    });
    expect(diffSummaryHasChanges(zero)).toBe(false);

    const onlyTracks = makeDiffSummary({
      totalChanges: 0,
      metadataChanges: 0,
      channelChanges: 0,
      patternChanges: 0,
      mixerChanges: 0,
      arrangementChanges: 0,
      opaqueChanges: 0,
      trackChanges: 3,
      humanLabel: "3 tracks modified",
    });
    expect(diffSummaryHasChanges(onlyTracks)).toBe(true);
  });

  test("DiffSummary validator rejects empty label", () => {
    expect(() =>
      makeDiffSummary({
        totalChanges: 0,
        metadataChanges: 0,
        channelChanges: 0,
        patternChanges: 0,
        mixerChanges: 0,
        arrangementChanges: 0,
        opaqueChanges: 0,
        humanLabel: "",
      }),
    ).toThrow();
  });

  test("computeSummaryCounts aggregates correctly", () => {
    const counts = computeSummaryCounts({
      metadataChanges: [],
      channelChanges: [
        makeChannelDiff({
          identity: ["channel", 0],
          kind: "modified",
          name: "Kick",
          humanLabel: "Channel 'Kick' modified",
        }),
      ],
      patternChanges: [],
      mixerChanges: makeMixerDiff({
        inserts: [
          makeMixerInsertDiff({
            identity: ["insert", 1],
            kind: "modified",
            index: 1,
            name: "Drums",
            humanLabel: "Drums modified",
          }),
        ],
        changes: [
          makeChange({
            path: "mixer.apdc",
            kind: "modified",
            oldValue: true,
            newValue: false,
            humanLabel: "APDC toggled",
          }),
        ],
      }),
      arrangementChanges: [],
      opaqueChanges: [],
    });
    expect(counts.channels).toBe(1);
    expect(counts.mixer).toBe(2); // 1 insert + 1 mixer-wide change
    expect(counts.total).toBe(3);
  });
});
