import { describe, test, expect } from "bun:test";
import { colorizeSummary } from "../src/diff/colorize.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

describe("colorizeSummary — top-level markers", () => {
  test("colours + at 2-space indent green", () => {
    expect(colorizeSummary('  + Added channel "Kick"')).toBe(
      `  ${GREEN}+${RESET} Added channel "Kick"`,
    );
  });

  test("colours - at 2-space indent red", () => {
    expect(colorizeSummary('  - Removed channel "FX Hit"')).toBe(
      `  ${RED}-${RESET} Removed channel "FX Hit"`,
    );
  });

  test("colours ~ at 2-space indent yellow", () => {
    expect(colorizeSummary('  ~ "Lead" volume 78% → 85%')).toBe(
      `  ${YELLOW}~${RESET} "Lead" volume 78% → 85%`,
    );
  });

  test("colours nested markers at 6-space indent", () => {
    const input = "      + Insert renamed from unset to 'Dub Vocal'";
    expect(colorizeSummary(input)).toBe(
      `      ${GREEN}+${RESET} Insert renamed from unset to 'Dub Vocal'`,
    );
  });
});

describe("colorizeSummary — left alone", () => {
  test("section headers untouched", () => {
    expect(colorizeSummary("Channels:")).toBe("Channels:");
  });

  test("summary line untouched", () => {
    const line = "Summary: 4 changes (2 channels, 1 mixer, 1 arrangements)";
    expect(colorizeSummary(line)).toBe(line);
  });

  test("title + rule line untouched", () => {
    expect(colorizeSummary("FLP Diff: v1.flp vs v2.flp")).toBe(
      "FLP Diff: v1.flp vs v2.flp",
    );
  });

  test("4-space indent (not a marker level) left alone", () => {
    expect(colorizeSummary("    + not a top-level change")).toBe(
      "    + not a top-level change",
    );
  });

  test("marker at column 0 left alone", () => {
    expect(colorizeSummary("+ not indented")).toBe("+ not indented");
  });

  test("leading dash inside a word not treated as marker", () => {
    expect(colorizeSummary("  -not-a-marker")).toBe("  -not-a-marker");
  });

  test("empty line preserved", () => {
    expect(colorizeSummary("")).toBe("");
  });
});

describe("colorizeSummary — multi-line", () => {
  test("colours only top-level, leaves sub-bullets plain", () => {
    const body = [
      "Channels:",
      '  ~ Channel sampler "Kick" modified (1 changes)',
      "      ~ Channel volume 78% → 100%",
      '  + Added channel sampler "Dub Vocal"',
    ].join("\n");
    const out = colorizeSummary(body);
    expect(out).toContain(`  ${YELLOW}~${RESET} Channel sampler "Kick"`);
    expect(out).toContain(`      ${YELLOW}~${RESET} Channel volume`);
    expect(out).toContain(`  ${GREEN}+${RESET} Added channel sampler`);
    expect(out.startsWith("Channels:\n")).toBe(true);
  });

  test("preserves line count and ordering", () => {
    const body = "a\n  + b\n  - c\nSummary: d";
    const out = colorizeSummary(body);
    expect(out.split("\n")).toHaveLength(4);
    expect(out.split("\n")[0]).toBe("a");
    expect(out.split("\n")[3]).toBe("Summary: d");
  });
});
