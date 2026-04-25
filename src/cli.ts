#!/usr/bin/env bun
import { parseFLPFile } from "./parser/flp-project.ts";
import { FLPParseError } from "./parser/errors.ts";
import { extractHeadline, diffHeadlines, renderHeadlineDiff } from "./diff/headline.ts";

const EXIT_IDENTICAL = 0;
const EXIT_DIFFERENCES = 1;
const EXIT_ERROR = 2;

const USAGE = `Usage: flpdiff-ts <A.flp> <B.flp>

Compares the headline fields (FL version, tempo, PPQ) of two FL Studio
project files and prints a one-line diff per changed field.

Exit codes:
  0  headlines identical
  1  one or more headline fields differ
  2  parse or I/O error

Scope: Phase 3.2.4 proof-of-concept. Full entity coverage (channels,
patterns, mixer, arrangements) is future work — see Phase 3.3 in the
dev repo's spec.
`;

export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length !== 2) {
    Bun.write(Bun.stderr, USAGE);
    return EXIT_ERROR;
  }
  const [pathA, pathB] = argv as [string, string];

  try {
    const [bufA, bufB] = await Promise.all([
      Bun.file(pathA).arrayBuffer(),
      Bun.file(pathB).arrayBuffer(),
    ]);
    const projA = parseFLPFile(bufA);
    const projB = parseFLPFile(bufB);
    const diff = diffHeadlines(extractHeadline(projA), extractHeadline(projB));
    console.log(renderHeadlineDiff(diff));
    return diff.hasChanges ? EXIT_DIFFERENCES : EXIT_IDENTICAL;
  } catch (e) {
    if (e instanceof FLPParseError) {
      console.error(`flpdiff-ts: parse error\n${e.message}`);
    } else if (e instanceof Error) {
      console.error(`flpdiff-ts: ${e.message}`);
    } else {
      console.error(`flpdiff-ts: ${String(e)}`);
    }
    return EXIT_ERROR;
  }
}

// Entry-point guard. When imported for tests, do not auto-run.
if (import.meta.main) {
  const code = await run(Bun.argv.slice(2));
  process.exit(code);
}
