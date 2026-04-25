import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  buildProjectSummary,
  parseFLPFile,
  type ProjectSummary,
  type InsertSummary,
  type ArrangementSummary,
} from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

async function summaryOf(name: string): Promise<ProjectSummary> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return buildProjectSummary(parseFLPFile(buf));
}

const FACTORY_909_KICK =
  "%FLStudioFactoryData%/Data/Patches/Packs/Drums/Kicks/909 Kick.wav";

// Every FL 25 base project we have emits 18 empty inserts (master + 17).
// Each insert carries 10 empty slots with indices 0..9.
const DEFAULT_INSERTS: InsertSummary[] = Array.from({ length: 18 }, (_, i) => ({
  index: i,
  slots: Array.from({ length: 10 }, (__, j) => ({ index: j })),
}));

// Every FL 25 base project has exactly one arrangement, id=0, named
// "Arrangement", with the default 500 track slots.
const DEFAULT_ARRANGEMENT: ArrangementSummary[] = [
  { id: 0, name: "Arrangement", trackCount: 500 },
];

/**
 * Full-structure oracle for each of the five committed FL 25 public
 * fixtures. Values cross-checked against Python's `flp-info --format=json`
 * output — see the per-feature tests in channels/mixer/patterns/
 * arrangements for the oracle derivation steps.
 *
 * This suite is the "everything matches" regression guard: one
 * structural equality per fixture, catching any silent shape drift
 * when new opcodes land in the walker.
 */
const ORACLE: Record<string, ProjectSummary> = {
  "base_empty.flp": {
    ppq: 96,
    tempo: 120,
    channels: [{ iid: 0, kind: "sampler", name: "Sampler" }],
    inserts: DEFAULT_INSERTS,
    patterns: [],
    arrangements: DEFAULT_ARRANGEMENT,
  },

  "base_one_channel.flp": {
    ppq: 96,
    tempo: 120,
    channels: [
      { iid: 0, kind: "sampler", name: "Sampler" },
      { iid: 1, kind: "sampler", name: "Kick", sample_path: FACTORY_909_KICK },
    ],
    inserts: DEFAULT_INSERTS,
    patterns: [],
    arrangements: DEFAULT_ARRANGEMENT,
  },

  "base_one_insert.flp": {
    ppq: 96,
    tempo: 120,
    channels: [{ iid: 0, kind: "sampler", name: "Sampler" }],
    inserts: DEFAULT_INSERTS.map((ins, i) =>
      i === 1
        ? {
            index: 1,
            name: "Drums",
            slots: [
              { index: 0, pluginName: "Fruity Parametric EQ 2" },
              ...ins.slots.slice(1),
            ],
          }
        : ins,
    ),
    patterns: [],
    arrangements: DEFAULT_ARRANGEMENT,
  },

  "base_one_pattern.flp": {
    ppq: 96,
    tempo: 120,
    channels: [
      { iid: 0, kind: "sampler", name: "Sampler" },
      { iid: 1, kind: "sampler", name: "Kick", sample_path: FACTORY_909_KICK },
    ],
    inserts: DEFAULT_INSERTS,
    patterns: [{ id: 1, name: "P1" }],
    arrangements: DEFAULT_ARRANGEMENT,
  },

  "base_one_serum.flp": {
    ppq: 96,
    tempo: 120,
    channels: [
      { iid: 0, kind: "sampler", name: "Sampler" },
      {
        iid: 1,
        kind: "instrument",
        name: "SerumTest",
        plugin: { internalName: "Fruity Wrapper" },
      },
    ],
    inserts: DEFAULT_INSERTS,
    patterns: [],
    arrangements: DEFAULT_ARRANGEMENT,
  },
};

describe("Full-project structural oracle across all 5 fixtures", () => {
  test.each(Object.keys(ORACLE))("%s: summary matches oracle", async (name) => {
    const actual = await summaryOf(name);
    expect(actual).toEqual(ORACLE[name]!);
  });
});

describe("buildProjectSummary — shape guarantees", () => {
  test.each(Object.keys(ORACLE))("%s: only exposes covered fields", async (name) => {
    const summary = await summaryOf(name);
    // Keys are stable — if this assertion fires, buildProjectSummary
    // has added a field without an oracle update.
    expect(Object.keys(summary).sort()).toEqual([
      "arrangements",
      "channels",
      "inserts",
      "patterns",
      "ppq",
      "tempo",
    ]);
  });
});
