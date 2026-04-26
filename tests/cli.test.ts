import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  diffHeadlines,
  renderHeadlineDiff,
  extractHeadline,
  type Headline,
} from "../src/diff/headline.ts";
import { run } from "../src/cli.ts";
import { parseFLPFile } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");
const BASE = resolve(CORPUS_DIR, "base_empty.flp");
const OTHER = resolve(CORPUS_DIR, "base_one_channel.flp");

describe("diffHeadlines — pure logic", () => {
  const identical: Headline = { version: "FL 25.2.4", tempo: 120, ppq: 96 };

  test("unchanged headlines produce no differences", () => {
    const d = diffHeadlines(identical, identical);
    expect(d.hasChanges).toBe(false);
    expect(renderHeadlineDiff(d)).toBe("No headline changes.");
  });

  test("different tempo shows a tempo line only", () => {
    const d = diffHeadlines(identical, { ...identical, tempo: 145 });
    expect(d.hasChanges).toBe(true);
    expect(d.tempo.kind).toBe("changed");
    expect(d.version.kind).toBe("unchanged");
    expect(d.ppq.kind).toBe("unchanged");
    const rendered = renderHeadlineDiff(d);
    expect(rendered).toContain("Tempo");
    expect(rendered).toContain("120.0 BPM");
    expect(rendered).toContain("145.0 BPM");
    expect(rendered).not.toContain("Version");
    expect(rendered).not.toContain("PPQ");
  });

  test("all three fields differ", () => {
    const d = diffHeadlines(identical, { version: "FL 26", tempo: 145, ppq: 192 });
    expect(d.hasChanges).toBe(true);
    const rendered = renderHeadlineDiff(d);
    expect(rendered).toContain("Version");
    expect(rendered).toContain("Tempo");
    expect(rendered).toContain("PPQ");
  });

  test("undefined field values render as <unknown>", () => {
    const missing: Headline = { version: undefined, tempo: undefined, ppq: 96 };
    const d = diffHeadlines(identical, missing);
    const rendered = renderHeadlineDiff(d);
    expect(rendered).toContain("<unknown>");
  });
});

describe("extractHeadline — end-to-end against a real fixture", () => {
  test("base_empty.flp produces a well-formed headline", async () => {
    const buf = await Bun.file(BASE).arrayBuffer();
    const headline = extractHeadline(parseFLPFile(buf));
    expect(headline.ppq).toBe(96);
    expect(headline.tempo).toBe(120);
    expect(headline.version).toBeDefined();
    expect(headline.version).toContain("25.2.4");
  });
});

describe("CLI — end-to-end", () => {
  test("exits 0 when comparing a file against itself", async () => {
    const code = await run([BASE, BASE]);
    expect(code).toBe(0);
  });

  test("exits 1 when two fixtures differ semantically", async () => {
    // As of Phase 3.4.4 the CLI runs a full semantic diff, not a
    // headline-only check. BASE and OTHER have the same headline
    // (version/tempo/ppq) but different channel/mixer content, so
    // the full diff fires and exits 1.
    const code = await run([BASE, OTHER]);
    expect(code).toBe(1);
  });

  test("exits 2 with missing arguments", async () => {
    const code = await run([]);
    expect(code).toBe(2);
  });

  test("exits 2 on nonexistent file", async () => {
    const code = await run([BASE, "/tmp/definitely-not-a-real-flp-file.flp"]);
    expect(code).toBe(2);
  });

  test("exits 2 on malformed file", async () => {
    const bogus = "/tmp/flpdiff-ts-bogus.flp";
    await Bun.write(bogus, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    const code = await run([bogus, bogus]);
    expect(code).toBe(2);
  });
});
