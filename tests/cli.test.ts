import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  diffHeadlines,
  renderHeadlineDiff,
  extractHeadline,
  type Headline,
} from "../src/diff/headline.ts";
import { run, handleError, ISSUE_URL } from "../src/cli.ts";
import { FLPParseError } from "../src/parser/errors.ts";
import { parseFLPFile } from "../src/index.ts";

const CORPUS_DIR = resolve(import.meta.dir, "./corpus/re_base/fl25");
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
    const bogus = "/tmp/flpdiff-bogus.flp";
    await Bun.write(bogus, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    const code = await run([bogus, bogus]);
    expect(code).toBe(2);
  });

  test("--version prints version and exits 0", async () => {
    const code = await run(["--version"]);
    expect(code).toBe(0);
  });

  test("--help prints usage and exits 0", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
  });
});

describe("CLI — info subcommand", () => {
  test("info <file> exits 0 with a human-readable report", async () => {
    const code = await run(["info", BASE]);
    expect(code).toBe(0);
  });

  test("info --format json exits 0", async () => {
    const code = await run(["info", BASE, "--format", "json"]);
    expect(code).toBe(0);
  });

  test("info rejects unknown format", async () => {
    const code = await run(["info", BASE, "--format", "xml"]);
    expect(code).toBe(2);
  });

  test("info canonical exits 0 + output starts with the header line", async () => {
    // Redirect stdout so we can assert on the content.
    const origWrite = Bun.write;
    const chunks: string[] = [];
    // @ts-expect-error — test-only override
    Bun.write = (target: unknown, content: string | Uint8Array) => {
      if (target === Bun.stdout && typeof content === "string") chunks.push(content);
      return content.length;
    };
    try {
      const code = await run(["info", BASE, "--format", "canonical"]);
      expect(code).toBe(0);
      const out = chunks.join("");
      expect(out.startsWith("# flpdiff canonical v1\n")).toBe(true);
      expect(out.endsWith("\n")).toBe(true);
    } finally {
      Bun.write = origWrite;
    }
  });

  test("info without file prints usage + exits 2", async () => {
    const code = await run(["info"]);
    expect(code).toBe(2);
  });
});

describe("CLI — error reporting nudges", () => {
  /** Capture console.error calls produced during `fn()`. */
  async function captureStderr(fn: () => unknown | Promise<unknown>): Promise<string> {
    const origErr = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
    try {
      await fn();
    } finally {
      console.error = origErr;
    }
    return lines.join("\n");
  }

  test("ISSUE_URL points at the dawhubapp issues tracker", () => {
    expect(ISSUE_URL).toBe("https://github.com/dawhubapp/flpdiff/issues");
  });

  test("FLPParseError → 'FLP variant' nudge with FL-version + .flp guidance", async () => {
    const err = new FLPParseError(
      {
        schemaName: "FLhd",
        byteOffsetAbsolute: 0,
        nestingPath: ["FLPProject", "FLhd"],
      },
      "magic mismatch",
    );
    const out = await captureStderr(() => {
      const code = handleError(err);
      expect(code).toBe(2);
    });
    expect(out).toContain("flpdiff: parse error");
    expect(out).toContain("hasn't seen this exact FLP variant yet");
    expect(out).toContain(ISSUE_URL);
    expect(out).toContain("FL Studio version");
    expect(out).toContain("flpdiff info");
    expect(out).toContain(".flp");
  });

  test("plain Error → soft 'If this looks like a bug' nudge with URL", async () => {
    const err = new Error("ENOENT: no such file or directory, open '/x.flp'");
    const out = await captureStderr(() => {
      const code = handleError(err);
      expect(code).toBe(2);
    });
    expect(out).toContain("flpdiff: ENOENT");
    expect(out).toContain("If this looks like a bug");
    expect(out).toContain(ISSUE_URL);
    // Soft branch must NOT use the FLPParseError-specific phrasing.
    expect(out).not.toContain("FLP variant");
    // Stack trace stays hidden unless FLPDIFF_DEBUG is set. The
    // V8 stack format always begins with "Error: <msg>"; absence of
    // that header means no stack was printed.
    expect(out).not.toMatch(/^Error: /m);
  });

  test("plain Error with FLPDIFF_DEBUG=1 → includes stack trace", async () => {
    const orig = process.env.FLPDIFF_DEBUG;
    process.env.FLPDIFF_DEBUG = "1";
    try {
      const err = new Error("boom");
      const out = await captureStderr(() => {
        handleError(err);
      });
      expect(out).toContain("flpdiff: boom");
      expect(out).toContain("Error: boom");
      expect(out).toContain(ISSUE_URL);
    } finally {
      if (orig === undefined) delete process.env.FLPDIFF_DEBUG;
      else process.env.FLPDIFF_DEBUG = orig;
    }
  });

  test("non-Error throw → 'This looks like a bug' nudge with URL", async () => {
    const out = await captureStderr(() => {
      const code = handleError("something weird happened");
      expect(code).toBe(2);
    });
    expect(out).toContain("flpdiff: something weird happened");
    expect(out).toContain("This looks like a bug");
    expect(out).toContain(ISSUE_URL);
  });

  test("non-Error throw with object stringifies via String()", async () => {
    const out = await captureStderr(() => {
      handleError({ kind: "weirdness" });
    });
    expect(out).toContain("flpdiff:");
    expect(out).toContain(ISSUE_URL);
  });

  test("end-to-end: malformed file run() emits parse-error nudge to stderr", async () => {
    const bogus = "/tmp/flpdiff-bogus-nudge.flp";
    await Bun.write(bogus, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    const out = await captureStderr(async () => {
      const code = await run([bogus, bogus]);
      expect(code).toBe(2);
    });
    expect(out).toContain("flpdiff: parse error");
    expect(out).toContain(ISSUE_URL);
    expect(out).toContain("FLP variant");
  });

  test("end-to-end: nonexistent file run() emits soft bug nudge to stderr", async () => {
    const out = await captureStderr(async () => {
      const code = await run([BASE, "/tmp/definitely-not-here.flp"]);
      expect(code).toBe(2);
    });
    expect(out).toContain(ISSUE_URL);
    expect(out).toContain("If this looks like a bug");
  });
});
