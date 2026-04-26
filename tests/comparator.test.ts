import { test, expect, describe } from "bun:test";
import {
  classify,
  fmtNoneFriendly,
  fmtPct,
  fmtPan,
  fmtTimeSig,
  fmtBool,
  colorHex,
  scalarChange,
  compareMetadata,
  compareChannel,
  compareProjects,
  compareProjectsJson,
  type FlpInfoJson,
  type Match,
  type Change,
} from "../src/index.ts";

/**
 * Comparator unit tests — mirror Python's `tests/test_comparator.py`
 * for the scalar metadata + channel scalar + plugin identity paths
 * ported in Phase 3.4.2b. String outputs (`humanLabel`) must match
 * Python byte-for-byte; tests assert the exact phrasing.
 */

// Minimal constructors for FlpInfoJson shapes.
function meta(overrides: Partial<FlpInfoJson["metadata"]> = {}): FlpInfoJson["metadata"] {
  return {
    _type: "ProjectMetadata",
    title: "",
    artists: "",
    genre: "",
    comments: "",
    format: "project",
    ppq: 96,
    tempo: 120.0,
    time_signature: null,
    main_pitch: 0,
    main_volume: null,
    pan_law: 0,
    looped: false,
    show_info: false,
    url: null,
    data_path: null,
    created_on: null,
    time_spent: null,
    version: { _type: "FLVersion", major: 25, minor: 2, patch: 4, build: 4960 },
    ...overrides,
  };
}

type ChannelJson = FlpInfoJson["channels"][number];
function channel(overrides: Partial<ChannelJson> = {}): ChannelJson {
  return {
    _type: "Channel",
    iid: 0,
    kind: "sampler",
    name: null,
    sample_path: null,
    plugin: null,
    color: null,
    pan: 0,
    volume: 0.78125,
    enabled: true,
    muted: false,
    target_insert: null,
    automation_points: [],
    ...overrides,
  };
}

describe("Formatting primitives", () => {
  test("classify(old, new) for null-transitions", () => {
    expect(classify(null, "x")).toBe("added");
    expect(classify("x", null)).toBe("removed");
    expect(classify("a", "b")).toBe("modified");
  });

  test("fmtNoneFriendly — matches Python repr", () => {
    expect(fmtNoneFriendly(null)).toBe("unset");
    expect(fmtNoneFriendly(undefined)).toBe("unset");
    expect(fmtNoneFriendly("hello")).toBe("'hello'");
    // Empty string → `''` (Python repr), NOT "unset".
    expect(fmtNoneFriendly("")).toBe("''");
    expect(fmtNoneFriendly(42)).toBe("42");
    expect(fmtNoneFriendly(true)).toBe("True");
    expect(fmtNoneFriendly(false)).toBe("False");
  });

  test("fmtPct", () => {
    expect(fmtPct(null)).toBe("unset");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(0.78125)).toBe("78%");
    expect(fmtPct(1)).toBe("100%");
  });

  test("fmtPan — centered / L / R wording", () => {
    expect(fmtPan(null)).toBe("unset");
    expect(fmtPan(0)).toBe("centered");
    expect(fmtPan(-0.5)).toBe("50% L");
    expect(fmtPan(0.25)).toBe("25% R");
  });

  test("fmtTimeSig", () => {
    expect(fmtTimeSig(null)).toBe("unset");
    expect(fmtTimeSig({ numerator: 4, denominator: 4 })).toBe("4/4");
    expect(fmtTimeSig({ numerator: 3, denominator: 8 })).toBe("3/8");
  });

  test("fmtBool", () => {
    expect(fmtBool(true)).toBe("on");
    expect(fmtBool(false)).toBe("off");
  });

  test("colorHex — banker's rounding for 0.5 boundaries", () => {
    expect(colorHex(null)).toBe("unset");
    expect(colorHex({ red: 1, green: 0, blue: 0, alpha: 1 })).toBe("#ff0000");
    expect(colorHex({ red: 0, green: 1, blue: 0, alpha: 1 })).toBe("#00ff00");
    // FL's default channel gray: 65/69/72 → 0x41/0x45/0x48. Banker's
    // rounding on the `c * 255` roundtrip is exact for these integers.
    expect(colorHex({ red: 65 / 255, green: 69 / 255, blue: 72 / 255, alpha: 0 })).toBe(
      "#414548",
    );
  });
});

describe("scalarChange", () => {
  test("returns null when values equal", () => {
    expect(scalarChange("x", 1, 1, "label")).toBeNull();
    expect(scalarChange("x", null, null, "label")).toBeNull();
  });

  test("deep-equal for objects", () => {
    expect(
      scalarChange(
        "x",
        { red: 1, green: 0, blue: 0, alpha: 0 },
        { red: 1, green: 0, blue: 0, alpha: 0 },
        "label",
      ),
    ).toBeNull();
  });

  test("emits Change with classify-derived kind", () => {
    const c = scalarChange("x", null, 42, "added");
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("added");
    expect(c!.oldValue).toBe(null);
    expect(c!.newValue).toBe(42);
  });
});

describe("compareMetadata", () => {
  test("identical metadata produces zero changes", () => {
    expect(compareMetadata(meta(), meta())).toEqual([]);
  });

  test("tempo increase uses 'increased' phrasing with .0 floats", () => {
    const changes = compareMetadata(meta({ tempo: 120 }), meta({ tempo: 145 }));
    expect(changes.length).toBe(1);
    expect(changes[0]!.humanLabel).toBe("Tempo increased from 120.0 to 145.0 BPM");
    expect(changes[0]!.path).toBe("metadata.tempo");
  });

  test("tempo decrease uses 'decreased' phrasing", () => {
    const changes = compareMetadata(meta({ tempo: 145 }), meta({ tempo: 120 }));
    expect(changes[0]!.humanLabel).toBe("Tempo decreased from 145.0 to 120.0 BPM");
  });

  test("tempo with fractional value renders decimal natively", () => {
    const changes = compareMetadata(meta({ tempo: 120 }), meta({ tempo: 145.5 }));
    expect(changes[0]!.humanLabel).toBe("Tempo increased from 120.0 to 145.5 BPM");
  });

  test("PPQ change label", () => {
    const changes = compareMetadata(meta({ ppq: 96 }), meta({ ppq: 192 }));
    expect(changes[0]!.humanLabel).toBe("PPQ changed from 96 to 192");
  });

  test("title change renders empty string as '' (Python repr), quoted otherwise", () => {
    const changes = compareMetadata(meta({ title: "" }), meta({ title: "New Track" }));
    expect(changes[0]!.humanLabel).toBe("Title: '' → 'New Track'");
    expect(changes[0]!.path).toBe("metadata.title");
  });

  test("looped toggle", () => {
    const changes = compareMetadata(meta({ looped: false }), meta({ looped: true }));
    expect(changes[0]!.humanLabel).toBe("Loop playback on (was off)");
  });

  test("pan_law change", () => {
    const changes = compareMetadata(meta({ pan_law: 0 }), meta({ pan_law: 2 }));
    expect(changes[0]!.humanLabel).toBe("Pan law changed from 0 to 2");
  });

  test("multiple simultaneous changes preserved in order", () => {
    const changes = compareMetadata(
      meta({ tempo: 120, title: "" }),
      meta({ tempo: 140, title: "Song" }),
    );
    expect(changes.length).toBe(2);
    expect(changes[0]!.path).toBe("metadata.tempo");
    expect(changes[1]!.path).toBe("metadata.title");
  });
});

describe("compareChannel", () => {
  function matched(o: ChannelJson, n: ChannelJson): Match<ChannelJson> {
    return { old: o, new: n, confidence: "exact" };
  }

  test("added channel — 'Added channel' label", () => {
    const diff = compareChannel({
      old: null,
      new: channel({ iid: 3, name: "NewBass", kind: "instrument" }),
      confidence: "unmatched",
    });
    expect(diff.kind).toBe("added");
    expect(diff.humanLabel).toBe("Added channel instrument 'NewBass'");
  });

  test("added sampler with sample_path shows path fragment", () => {
    const diff = compareChannel({
      old: null,
      new: channel({
        iid: 3,
        name: "Kick",
        kind: "sampler",
        sample_path: { _type: "path", value: "kicks/909.wav" },
      }),
      confidence: "unmatched",
    });
    expect(diff.humanLabel).toBe("Added channel sampler 'Kick' (sample: kicks/909.wav)");
  });

  test("removed channel — 'Removed channel' label", () => {
    const diff = compareChannel({
      old: channel({ iid: 5, name: "OldSnare" }),
      new: null,
      confidence: "unmatched",
    });
    expect(diff.kind).toBe("removed");
    expect(diff.humanLabel).toBe("Removed channel sampler 'OldSnare'");
  });

  test("unchanged channel — 'unchanged' label when no changes", () => {
    const same = channel({ iid: 1, name: "Kick" });
    const diff = compareChannel(matched(same, same));
    expect(diff.humanLabel).toBe("Channel sampler 'Kick' unchanged");
    expect(diff.changes).toEqual([]);
  });

  test("name change renders with quoted strings", () => {
    const diff = compareChannel(
      matched(channel({ iid: 1, name: "A" }), channel({ iid: 1, name: "B" })),
    );
    const rename = diff.changes.find((c) => c.path === "channels[1].name")!;
    expect(rename.humanLabel).toBe("Channel renamed from 'A' to 'B'");
  });

  test("volume change uses fmtPct", () => {
    const diff = compareChannel(
      matched(channel({ iid: 0, volume: 0.5 }), channel({ iid: 0, volume: 0.78125 })),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].volume")!;
    expect(c.humanLabel).toBe("Channel volume 50% → 78%");
  });

  test("pan change uses L/R/centered phrasing", () => {
    const diff = compareChannel(
      matched(channel({ iid: 0, pan: 0 }), channel({ iid: 0, pan: -0.5 })),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].pan")!;
    expect(c.humanLabel).toBe("Channel pan centered → 50% L");
  });

  test("color change uses #rrggbb", () => {
    const diff = compareChannel(
      matched(
        channel({ iid: 0, color: { _type: "RGBA", red: 1, green: 0, blue: 0, alpha: 0 } }),
        channel({ iid: 0, color: { _type: "RGBA", red: 0, green: 1, blue: 0, alpha: 0 } }),
      ),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].color")!;
    expect(c.humanLabel).toBe("Channel color: #ff0000 → #00ff00");
  });

  test("enabled toggle uses 'on/off' phrasing", () => {
    const diff = compareChannel(
      matched(channel({ iid: 0, enabled: true }), channel({ iid: 0, enabled: false })),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].enabled")!;
    expect(c.humanLabel).toBe("Channel off (was on)");
  });

  test("plugin added label", () => {
    const diff = compareChannel(
      matched(
        channel({ iid: 0, plugin: null }),
        channel({
          iid: 0,
          plugin: { _type: "Plugin", name: "Serum", vendor: "Xfer Records", is_vst: true, state: null },
        }),
      ),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].plugin")!;
    expect(c.humanLabel).toBe("Plugin added: 'Serum' (Xfer Records, VST)");
  });

  test("plugin swap label (name changed)", () => {
    const diff = compareChannel(
      matched(
        channel({ iid: 0, plugin: { _type: "Plugin", name: "FruityDX10", vendor: null, is_vst: false, state: null } }),
        channel({ iid: 0, plugin: { _type: "Plugin", name: "Sytrus", vendor: null, is_vst: false, state: null } }),
      ),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].plugin.name")!;
    expect(c.humanLabel).toBe("Plugin swapped: FruityDX10 → Sytrus");
  });

  test("plugin vendor change fires when name unchanged", () => {
    const diff = compareChannel(
      matched(
        channel({
          iid: 0,
          plugin: { _type: "Plugin", name: "Serum", vendor: "Xfer Records", is_vst: true, state: null },
        }),
        channel({
          iid: 0,
          plugin: { _type: "Plugin", name: "Serum", vendor: "Xfer Records 2", is_vst: true, state: null },
        }),
      ),
    );
    const c = diff.changes.find((c) => c.path === "channels[0].plugin.vendor")!;
    expect(c.humanLabel).toBe("Plugin vendor: 'Xfer Records' → 'Xfer Records 2'");
  });

  test("multi-change count in entity label", () => {
    const diff = compareChannel(
      matched(
        channel({ iid: 0, name: "A", volume: 0.5 }),
        channel({ iid: 0, name: "B", volume: 0.8 }),
      ),
    );
    expect(diff.humanLabel).toBe("Channel sampler 'A' modified (2 changes)");
  });

  test("single change also uses 'changes' plural (Python convention)", () => {
    const diff = compareChannel(
      matched(channel({ iid: 0, name: "A" }), channel({ iid: 0, name: "B" })),
    );
    expect(diff.humanLabel).toBe("Channel sampler 'A' modified (1 changes)");
  });
});

describe("compareProjectsJson — orchestrator at JSON level", () => {
  function proj(
    channels: ChannelJson[] = [],
    metaOverrides: Partial<FlpInfoJson["metadata"]> = {},
  ): FlpInfoJson {
    return {
      _type: "FLPProject",
      metadata: meta(metaOverrides),
      channels,
      patterns: [],
      mixer: { _type: "Mixer", inserts: [] },
      arrangements: [],
      opaque_events: [],
      score_log: [],
    };
  }

  test("no changes → empty result", () => {
    const a = proj();
    const b = proj();
    const r = compareProjectsJson(a, b);
    expect(r.metadataChanges).toEqual([]);
    expect(r.channelChanges).toEqual([]);
  });

  test("tempo-only change produces one metadata entry, no channel entries", () => {
    const r = compareProjectsJson(proj([], { tempo: 120 }), proj([], { tempo: 145 }));
    expect(r.metadataChanges.length).toBe(1);
    expect(r.channelChanges).toEqual([]);
  });

  test("unchanged channels are dropped from the output", () => {
    const same = channel({ iid: 0 });
    const r = compareProjectsJson(proj([same]), proj([same]));
    expect(r.channelChanges).toEqual([]);
  });

  test("channel rename surfaces as exactly one ChannelDiff", () => {
    const r = compareProjectsJson(
      proj([channel({ iid: 0, name: "Kick" })]),
      proj([channel({ iid: 0, name: "Kick2" })]),
    );
    expect(r.channelChanges.length).toBe(1);
    expect(r.channelChanges[0]!.kind).toBe("modified");
  });

  test("added + removed channels both emit entries", () => {
    const r = compareProjectsJson(
      proj([channel({ iid: 1, name: "Gone" })]),
      proj([channel({ iid: 2, name: "New" })]),
    );
    expect(r.channelChanges.length).toBe(2);
    const kinds = r.channelChanges.map((c) => c.kind).sort();
    expect(kinds).toEqual(["added", "removed"]);
  });
});
