import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, formatPatternSummary, type Pattern } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");

async function patternsOf(name: string): Promise<Pattern[]> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return parseFLPFile(buf).patterns;
}

/**
 * Oracle values from Python's `flp-info`:
 *   base_empty, base_one_channel, base_one_insert, base_one_serum → 0 patterns
 *   base_one_pattern → 1 pattern named "P1"
 */
describe("Pattern extraction — oracle parity", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_serum.flp",
  ])("%s: 0 patterns", async (name) => {
    const patterns = await patternsOf(name);
    expect(patterns.length).toBe(0);
    expect(formatPatternSummary(patterns)).toBe("0 patterns");
  });

  test("base_one_pattern.flp: 1 pattern named 'P1'", async () => {
    const patterns = await patternsOf("base_one_pattern.flp");
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.name).toBe("P1");
    expect(formatPatternSummary(patterns)).toBe("1 pattern");
  });
});

describe("Pattern-identity dedup — the 'fires twice' rule", () => {
  test("base_one_pattern.flp: opcode 0x41 fires twice but produces one Pattern", async () => {
    const buf = await Bun.file(resolve(CORPUS_DIR, "base_one_pattern.flp")).arrayBuffer();
    const project = parseFLPFile(buf);

    // Raw event stream must contain two 0x41 events with the same id.
    const news = project.events.filter((e) => e.opcode === 0x41);
    expect(news.length).toBe(2);
    expect(news[0]!.kind).toBe("u16");
    expect(news[1]!.kind).toBe("u16");
    if (news[0]!.kind === "u16" && news[1]!.kind === "u16") {
      expect(news[0]!.value).toBe(news[1]!.value);
    }

    // But patterns[] must dedupe.
    expect(project.patterns.length).toBe(1);
  });
});

describe("Pattern length / color / looped", () => {
  test("base_one_pattern.flp: length=0, explicit color set, not looped", async () => {
    const patterns = await patternsOf("base_one_pattern.flp");
    const p = patterns[0]!;
    expect(p.length).toBe(0);
    expect(p.color).toEqual({ r: 52, g: 57, b: 58, a: 0 });
    // FL omits 0x1A when looped=false, so the field stays undefined —
    // which callers should interpret as "not looped".
    expect(p.looped).toBeUndefined();
  });
});

describe("formatPatternSummary — plural correctness", () => {
  test("0 → '0 patterns'", () => {
    expect(formatPatternSummary([])).toBe("0 patterns");
  });
  test("1 → '1 pattern' (singular)", () => {
    expect(formatPatternSummary([{ id: 0, notes: [], controllers: [] }])).toBe("1 pattern");
  });
  test("2 → '2 patterns' (plural)", () => {
    expect(formatPatternSummary([{ id: 0, notes: [], controllers: [] }, { id: 1, notes: [], controllers: [] }])).toBe("2 patterns");
  });
});
