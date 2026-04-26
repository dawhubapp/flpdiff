#!/usr/bin/env bun
/**
 * flpdiff-ts — full semantic diff CLI. As of Phase 3.4.4, this
 * operates on the full DiffResult (metadata + channels + patterns +
 * mixer + arrangements + clip-collapse groups) and produces output
 * byte-identical to Python's `flpdiff --format text`.
 */
import { parseFLPFile } from "./parser/flp-project.ts";
import { FLPParseError } from "./parser/errors.ts";
import { compareProjects } from "./diff/comparator.ts";
import { renderSummary } from "./diff/summary.ts";
import { diffSummaryHasChanges } from "./diff/diff-model.ts";
import { basename } from "node:path";

const EXIT_IDENTICAL = 0;
const EXIT_DIFFERENCES = 1;
const EXIT_ERROR = 2;

const USAGE = `Usage: flpdiff-ts [--verbose] <A.flp> <B.flp>

Compares two FL Studio project files and prints a semantic diff
covering metadata, channels, patterns, mixer inserts, and
arrangement tracks (with clip-collapse grouping).

Options:
  --verbose, -v  Expand clip-collapse groups back to per-clip lines.

Exit codes:
  0  files are semantically identical
  1  one or more differences found
  2  parse or I/O error
`;

export async function run(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let verbose = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--verbose" || args[i] === "-v") {
      args.splice(i, 1);
      verbose = true;
    }
  }
  if (args.length !== 2) {
    Bun.write(Bun.stderr, USAGE);
    return EXIT_ERROR;
  }
  const [pathA, pathB] = args as [string, string];

  try {
    const [bufA, bufB] = await Promise.all([
      Bun.file(pathA).arrayBuffer(),
      Bun.file(pathB).arrayBuffer(),
    ]);
    const projA = parseFLPFile(bufA);
    const projB = parseFLPFile(bufB);
    const result = compareProjects(projA, projB);
    const title = `${basename(pathA)} vs ${basename(pathB)}`;
    console.log(renderSummary(result, { title, verbose }));
    return diffSummaryHasChanges(result.summary) ? EXIT_DIFFERENCES : EXIT_IDENTICAL;
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
