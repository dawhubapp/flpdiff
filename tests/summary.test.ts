import { test, expect, describe } from "bun:test";
import {
  renderSummary,
  makeDiffSummary,
  makeChange,
  makeChannelDiff,
  makePatternDiff,
  makeMixerDiff,
  makeMixerInsertDiff,
  makeTrackDiff,
  makeArrangementDiff,
  makeNoteChange,
  type DiffResult,
} from "../src/index.ts";

function emptyResult(humanLabel = "No changes"): DiffResult {
  return {
    summary: makeDiffSummary({
      totalChanges: 0,
      metadataChanges: 0,
      channelChanges: 0,
      patternChanges: 0,
      mixerChanges: 0,
      arrangementChanges: 0,
      opaqueChanges: 0,
      humanLabel,
    }),
    metadataChanges: [],
    channelChanges: [],
    patternChanges: [],
    mixerChanges: makeMixerDiff(),
    arrangementChanges: [],
    opaqueChanges: [],
  };
}

describe("renderSummary — markers / indentation / structure", () => {
  test("no-changes result shows only the summary line", () => {
    const out = renderSummary(emptyResult());
    expect(out).toBe("Summary: No changes");
  });

  test("title adds header + divider", () => {
    const out = renderSummary(emptyResult(), { title: "a.flp vs b.flp" });
    expect(out.split("\n")).toEqual([
      "FLP Diff: a.flp vs b.flp",
      "─".repeat("FLP Diff: a.flp vs b.flp".length),
      "Summary: No changes",
    ]);
  });

  test("metadata changes render with marker + indent", () => {
    const r = emptyResult("1 changes (1 metadata)");
    r.summary.totalChanges = 1;
    r.summary.metadataChanges = 1;
    (r as any).metadataChanges = [
      makeChange({
        path: "metadata.tempo",
        kind: "modified",
        oldValue: 120,
        newValue: 140,
        humanLabel: "Tempo increased from 120.0 to 140.0 BPM",
      }),
    ];
    const out = renderSummary(r);
    expect(out).toContain("Metadata:");
    expect(out).toContain("  ~ Tempo increased from 120.0 to 140.0 BPM");
  });

  test("channel added uses '+' marker; modified uses '~'", () => {
    const r = emptyResult("2 changes (2 channels)");
    r.summary.totalChanges = 2;
    r.summary.channelChanges = 2;
    (r as any).channelChanges = [
      makeChannelDiff({
        identity: ["channel", 0],
        kind: "added",
        name: "NewSynth",
        humanLabel: "Added channel instrument 'NewSynth'",
      }),
      makeChannelDiff({
        identity: ["channel", 1],
        kind: "modified",
        name: "Kick",
        humanLabel: "Channel sampler 'Kick' modified (1 changes)",
        changes: [
          makeChange({
            path: "channels[1].volume",
            kind: "modified",
            oldValue: 0.5,
            newValue: 0.8,
            humanLabel: "Channel volume 50% → 80%",
          }),
        ],
      }),
    ];
    const out = renderSummary(r);
    expect(out).toContain("  + Added channel instrument 'NewSynth'");
    expect(out).toContain("  ~ Channel sampler 'Kick' modified (1 changes)");
    expect(out).toContain("      ~ Channel volume 50% → 80%");
  });

  test("note changes > 10 collapse to kind-bucketed with examples", () => {
    const notes = Array(15).fill(0).map((_, i) =>
      makeNoteChange({
        kind: "added",
        oldNote: null,
        newNote: { position: i * 48, key: 60, channel_iid: 1, velocity: 100, length: 48, pan: 64, release: 64, fine_pitch: 120 },
        humanLabel: `Added C5 on channel 1 at beat ${i / 2}`,
      }),
    );
    const r = emptyResult("1 changes (1 patterns, 15 notes)");
    r.summary.totalChanges = 1;
    r.summary.patternChanges = 1;
    r.summary.noteChanges = 15;
    (r as any).patternChanges = [
      makePatternDiff({
        identity: ["pattern", 0],
        kind: "modified",
        name: "P1",
        humanLabel: "Pattern 'p1' modified (15 changes)",
        noteChanges: notes,
      }),
    ];
    const out = renderSummary(r);
    expect(out).toContain("      + 15 notes added");
    // First 3 examples via "·"
    expect(out).toContain("          · Added C5 on channel 1 at beat 0");
    expect(out).toContain("          · … and 12 more");
  });

  test("clip-collapse groups hide covered per-clip changes in non-verbose", () => {
    const change1 = makeChange({
      path: "tracks[0].items[0]",
      kind: "added",
      oldValue: null,
      newValue: { _type: "PlaylistItem", position: 0 },
      humanLabel: "Added clip: 'X' at beat 0, length 4 beats",
    });
    const change2 = makeChange({
      path: "tracks[0].items[1]",
      kind: "added",
      oldValue: null,
      newValue: { _type: "PlaylistItem", position: 96 },
      humanLabel: "Added clip: 'X' at beat 1, length 4 beats",
    });
    const r = emptyResult("1 changes (1 arrangements, 1 tracks)");
    r.summary.totalChanges = 1;
    r.summary.arrangementChanges = 1;
    r.summary.trackChanges = 1;
    (r as any).arrangementChanges = [
      makeArrangementDiff({
        identity: ["arrangement", 0],
        kind: "modified",
        name: "Main",
        humanLabel: "Arrangement 'main' modified (0 arrangement changes, 1 track changes)",
        trackChanges: [
          makeTrackDiff({
            identity: ["track", 0],
            kind: "modified",
            index: 0,
            name: "T1",
            humanLabel: "Track 't1' modified (2 changes)",
            changes: [change1, change2],
            clipBulkGroups: [
              {
                kind: "added",
                refLabel: "'X'",
                lengthTicks: 384,
                muted: false,
                count: 2,
                positions: [0, 96],
                changePaths: ["tracks[0].items[0]", "tracks[0].items[1]"],
                humanLabel: "2 clips of 'X' added (length 4 beats, beats 0, 1)",
              } as any,
            ],
          }),
        ],
      }),
    ];
    const nonVerbose = renderSummary(r);
    // Group line present, individual clips hidden
    expect(nonVerbose).toContain("          + 2 clips of 'X' added (length 4 beats, beats 0, 1)");
    expect(nonVerbose).not.toContain("Added clip: 'X' at beat 0");
    // Verbose flag expands
    const verbose = renderSummary(r, { verbose: true });
    expect(verbose).toContain("Added clip: 'X' at beat 0, length 4 beats");
  });

  test("mixer insert + plugin sub-change", () => {
    const r = emptyResult("1 changes (1 mixer)");
    r.summary.totalChanges = 1;
    r.summary.mixerChanges = 1;
    (r as any).mixerChanges = makeMixerDiff({
      inserts: [
        makeMixerInsertDiff({
          identity: ["insert", 3],
          kind: "modified",
          index: 3,
          name: "Drums",
          humanLabel: "Insert 3 (Drums) modified (1 changes)",
          changes: [
            makeChange({
              path: "mixer.inserts[3].volume",
              kind: "modified",
              oldValue: 0.5,
              newValue: 0.8,
              humanLabel: "Insert volume 50% → 80%",
            }),
          ],
        }),
      ],
    });
    const out = renderSummary(r);
    expect(out).toContain("Mixer:");
    expect(out).toContain("  ~ Insert 3 (Drums) modified (1 changes)");
    expect(out).toContain("      ~ Insert volume 50% → 80%");
  });
});
