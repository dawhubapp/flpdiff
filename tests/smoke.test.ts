import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { parseFLPFile, getFLVersionBanner, getTempo } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");

async function loadFLP(name: string): Promise<ArrayBuffer> {
  const path = resolve(CORPUS_DIR, name);
  const file = Bun.file(path);
  return await file.arrayBuffer();
}

test("parseFLPFile handles base_empty.flp end-to-end", async () => {
  const buf = await loadFLP("base_empty.flp");
  const project = parseFLPFile(buf);

  // Header sanity
  expect(project.header.ppq).toBe(96);
  expect(project.header.format).toBe(0);

  // Event stream is non-empty
  expect(project.events.length).toBeGreaterThan(0);

  // Oracle values from Python's `flp-info` on the same file
  expect(getTempo(project)).toBe(120);

  const banner = getFLVersionBanner(project);
  expect(banner).toBeDefined();
  expect(banner).toContain("25.2.4");
});

test("event kinds distribute across all four opcode ranges", async () => {
  const buf = await loadFLP("base_empty.flp");
  const project = parseFLPFile(buf);

  const kinds = new Set(project.events.map((e) => e.kind));
  // A real FL 25 project exercises every range — this catches regressions
  // where one range accidentally gets routed to another.
  expect(kinds.has("u8")).toBe(true);
  expect(kinds.has("u16")).toBe(true);
  expect(kinds.has("u32")).toBe(true);
  expect(kinds.has("blob")).toBe(true);
});

test("FLPParseError carries byte-offset context on corrupt input", () => {
  // "FLhd" header with the wrong length byte triggers a readHeader failure
  // at byte 4. The thrown FLPParseError must include that offset and path.
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
