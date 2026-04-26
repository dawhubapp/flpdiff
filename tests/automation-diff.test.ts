import { test, expect, describe } from "bun:test";
import { diffAutomationPoints, type AutomationPointJson } from "../src/index.ts";

/**
 * Port of Python's tests/test_automation_diff.py. Same cases, same
 * expected labels.
 */

function kf(position: number, value: number, tension = 0): AutomationPointJson {
  return { _type: "AutomationPoint", position, value, tension };
}

describe("diffAutomationPoints", () => {
  test("identical keyframes → empty result", () => {
    const pts = [kf(0, 0.5), kf(48, 1.0)];
    expect(diffAutomationPoints(pts, pts, 96)).toEqual([]);
  });

  test("empty → added-only", () => {
    const pts = [kf(0, 0.5)];
    const cs = diffAutomationPoints([], pts, 96);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe("added");
    expect(cs[0]!.humanLabel).toBe("Added keyframe at beat 0 (value 0.5)");
  });

  test("empty ← removed-only", () => {
    const pts = [kf(96, 1.0)];
    const cs = diffAutomationPoints(pts, [], 96);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe("removed");
    expect(cs[0]!.humanLabel).toBe("Removed keyframe at beat 1 (value 1)");
  });

  test("same position, value changed → modified", () => {
    const cs = diffAutomationPoints([kf(48, 0.5)], [kf(48, 0.8)], 96);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe("modified");
    expect(cs[0]!.humanLabel).toBe("Keyframe at beat 0.5: value 0.5 → 0.8");
  });

  test("value + tension both change", () => {
    const cs = diffAutomationPoints(
      [kf(48, 0.5, -0.5)],
      [kf(48, 0.8, 0.25)],
      96,
    );
    expect(cs[0]!.humanLabel).toBe(
      "Keyframe at beat 0.5: value 0.5 → 0.8, tension -0.5 → 0.25",
    );
  });

  test("horizontal drag surfaces as remove + add (no 'moved' kind)", () => {
    const cs = diffAutomationPoints([kf(0, 0.5)], [kf(48, 0.5)], 96);
    expect(cs).toHaveLength(2);
    const kinds = cs.map((c) => c.kind);
    // Timeline order: position 0 comes first (removed), then 48 (added).
    expect(kinds).toEqual(["removed", "added"]);
  });

  test("timeline ordering across mixed kinds", () => {
    const oldPts = [kf(0, 0.5), kf(96, 0.25), kf(192, 1.0)];
    const newPts = [
      kf(0, 0.5), // identical
      kf(48, 0.75), // added
      kf(96, 0.4), // modified (was 0.25)
      // position 192 removed
    ];
    const cs = diffAutomationPoints(oldPts, newPts, 96);
    // Expected timeline: beat 0.5 added → beat 1 modified → beat 2 removed.
    const positions = cs.map((c) => {
      const pt = (c.oldPoint ?? c.newPoint) as AutomationPointJson;
      return pt.position;
    });
    expect(positions).toEqual([48, 96, 192]);
    expect(cs.map((c) => c.kind)).toEqual(["added", "modified", "removed"]);
  });

  test("same-position tie resolves modified → removed → added", () => {
    // Craft a case where three changes end up at the same position:
    // one modified plus, unusually, one added with duplicate position.
    const oldPts = [kf(48, 0.5)];
    const newPts = [kf(48, 0.6), kf(48, 0.7)];
    const cs = diffAutomationPoints(oldPts, newPts, 96);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.kind).toBe("modified");
    expect(cs[1]!.kind).toBe("added");
  });
});
