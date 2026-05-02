import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, getFLVersionBanner, getTempo } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");

async function loadFLP(name: string): Promise<ArrayBuffer> {
  return await Bun.file(resolve(CORPUS_DIR, name)).arrayBuffer();
}

/**
 * Oracle values sourced from Python's `flp-info` output on each committed
 * FL 25 fixture (see the tests/corpus/re_base/fl25/).
 *
 * All five minimal bases currently share header values — the files differ
 * in their later event-stream contents (channels, patterns, inserts,
 * plugin state), not in metadata.
 */
const ORACLE = {
  flVersionMatches: /25\.2\.4/,
  tempo: 120,
  ppq: 96,
};

const FIXTURES: string[] = [
  "base_empty.flp",
  "base_one_channel.flp",
  "base_one_insert.flp",
  "base_one_pattern.flp",
  "base_one_serum.flp",
];

describe("FL 25 public corpus — headline parity", () => {
  test.each(FIXTURES)("parses %s and matches Python flp-info headline", async (name) => {
    const buf = await loadFLP(name);
    const project = parseFLPFile(buf);

    expect(project.header.ppq).toBe(ORACLE.ppq);
    expect(project.header.format).toBe(0);
    expect(project.events.length).toBeGreaterThan(0);

    expect(getTempo(project)).toBe(ORACLE.tempo);

    const banner = getFLVersionBanner(project);
    expect(banner).toBeDefined();
    expect(banner).toMatch(ORACLE.flVersionMatches);
  });

  test.each(FIXTURES)("%s: event stream exercises all four kinds", async (name) => {
    const buf = await loadFLP(name);
    const project = parseFLPFile(buf);
    const kinds = new Set(project.events.map((e) => e.kind));
    expect(kinds.has("u8")).toBe(true);
    expect(kinds.has("u16")).toBe(true);
    expect(kinds.has("u32")).toBe(true);
    expect(kinds.has("blob")).toBe(true);
  });

  // Regression for issue #1: the FL version banner is a 0xC0 (TEXT range)
  // event with varint-prefixed UTF-16LE payload — NOT a 0x36 utf16_zterm
  // event. The two interpretations consume the same byte range, but the
  // event identity differs. We assert: (a) a 0xC0 blob carrying the banner
  // exists, (b) no 0x36 blob masquerades as the banner, (c) 0xAC carries
  // a 3-byte payload.
  test.each(FIXTURES)("%s: banner sits on opcode 0xC0, 0xAC is 3-byte", async (name) => {
    const buf = await loadFLP(name);
    const project = parseFLPFile(buf);

    const c0 = project.events.find(
      (e) => e.kind === "blob" && e.opcode === 0xc0,
    );
    expect(c0).toBeDefined();
    expect(c0?.kind).toBe("blob");

    const stray0x36Blob = project.events.find(
      (e) => e.kind === "blob" && e.opcode === 0x36,
    );
    expect(stray0x36Blob).toBeUndefined();

    const ac = project.events.find((e) => e.opcode === 0xac);
    expect(ac).toBeDefined();
    expect(ac?.kind).toBe("blob");
    if (ac?.kind === "blob") expect(ac.payload.byteLength).toBe(3);
  });
});

test("FLPParseError carries byte-offset + path context on corrupt input", () => {
  const bad = new Uint8Array([
    0x46, 0x4c, 0x68, 0x64, // "FLhd"
    0x99, 0x00, 0x00, 0x00, // bogus length 0x99 (expected 6)
  ]);

  let caught: unknown;
  try {
    parseFLPFile(bad.buffer);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(String(caught)).toContain("at byte");
  expect(String(caught)).toContain("FLhd");
});
