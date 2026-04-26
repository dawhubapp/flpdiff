import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, renderCanonical, CANONICAL_HEADER } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

async function canonOf(name: string): Promise<string> {
  const buf = await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
  return renderCanonical(parseFLPFile(buf));
}

describe("renderCanonical — format structure", () => {
  test("header is the first line", async () => {
    const out = await canonOf("base_empty.flp");
    expect(out.startsWith(`${CANONICAL_HEADER}\n`)).toBe(true);
  });

  test("trailing newline", async () => {
    const out = await canonOf("base_empty.flp");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("metadata section with version + ppq + tempo", async () => {
    const out = await canonOf("base_empty.flp");
    expect(out).toContain("## metadata");
    expect(out).toContain("version: 25.2.4.4960");
    expect(out).toContain("ppq: 96");
    expect(out).toContain("tempo: 120");
  });

  test("channels section names each channel with kind bracket", async () => {
    const out = await canonOf("base_one_channel.flp");
    // Example: "### channel 0 [sampler]"
    expect(out).toMatch(/### channel \d+ \[sampler\]/);
  });

  test("mixer section header always present on FL25 (Master exists)", async () => {
    const out = await canonOf("base_empty.flp");
    expect(out).toContain("## mixer");
  });

  test("arrangements section present on FL25 base", async () => {
    const out = await canonOf("base_empty.flp");
    expect(out).toContain("## arrangements");
    expect(out).toContain("### arrangement 0");
  });
});

describe("renderCanonical — default-value suppression", () => {
  test("default unmodified channel doesn't emit pan/volume=0 lines", async () => {
    const out = await canonOf("base_empty.flp");
    // "pan: 0" on a default-gray channel would be noise — check it's absent.
    // (The default pan value is 6400 raw which normalises to 1.0; so we
    // actually expect pan: 1 to appear, but not pan: 0.)
    const panZeroMatches = (out.match(/\npan: 0$/gm) ?? []).length;
    expect(panZeroMatches).toBe(0);
  });

  test("no `muted: true` line when default (muted is false)", async () => {
    const out = await canonOf("base_empty.flp");
    // "muted: true" should only appear if a channel is actually muted.
    expect(out).not.toContain("muted: true");
  });
});

describe("renderCanonical — byte-stable across calls", () => {
  test.each([
    "base_empty.flp",
    "base_one_channel.flp",
    "base_one_insert.flp",
    "base_one_pattern.flp",
    "base_one_serum.flp",
  ])("%s: two consecutive renders are byte-identical", async (name) => {
    const a = await canonOf(name);
    const b = await canonOf(name);
    expect(a).toBe(b);
  });
});
