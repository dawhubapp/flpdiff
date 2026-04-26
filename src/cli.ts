#!/usr/bin/env bun
/**
 * flpdiff — single canonical CLI. Subcommands:
 *
 *   flpdiff A.flp B.flp [--verbose]       # diff (default)
 *   flpdiff info A.flp [--format ...]     # single-file report
 *   flpdiff git-setup ...                 # git integration (Phase L2)
 *   flpdiff git-driver ...                # internal driver (Phase L2)
 *
 * If the first positional arg isn't a recognised subcommand, it's
 * treated as the first FLP path of a diff invocation.
 */
import { parseFLPFile } from "./parser/flp-project.ts";
import { FLPParseError } from "./parser/errors.ts";
import { compareProjects } from "./diff/comparator.ts";
import { renderSummary } from "./diff/summary.ts";
import { diffSummaryHasChanges } from "./diff/diff-model.ts";
import { toFlpInfoJson } from "./presentation/flp-info.ts";
import { renderInfo } from "./info.ts";
import { renderCanonical } from "./canonical.ts";
import {
  gitDriverMain,
  setupGit,
  renderSetupRecap,
  verifyGit,
  renderVerifyReport,
  type Scope,
  type DriverMode,
} from "./git.ts";
import { basename } from "node:path";

const EXIT_IDENTICAL = 0;
const EXIT_DIFFERENCES = 1;
const EXIT_ERROR = 2;

const USAGE = `Usage:
  flpdiff [--verbose] <A.flp> <B.flp>         Semantic diff between two FLPs
  flpdiff info <file.flp> [--format F]        Inspect a single FLP
    F ∈ text (default) | json | canonical
  flpdiff git-setup [--global] [--textconv] [--lfs]
                                              Configure git to use flpdiff as the FLP diff driver
  flpdiff git-verify                          Diagnose the current repo's flpdiff git setup
  flpdiff git-driver <...7 or 9 args...>      Internal: invoked by git's external-diff protocol
  flpdiff --help | --version

Exit codes (diff):
  0  files are semantically identical
  1  one or more differences found
  2  parse or I/O error
`;

const SUBCOMMANDS = new Set(["info", "git-setup", "git-driver", "git-verify"]);

// Version is read from package.json at build time; for now, inline.
const VERSION = "0.1.0";

export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    Bun.write(Bun.stderr, USAGE);
    return EXIT_ERROR;
  }

  // --help / --version short-circuit.
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    console.log(`flpdiff ${VERSION}`);
    return 0;
  }

  const first = argv[0]!;
  if (SUBCOMMANDS.has(first)) {
    const rest = argv.slice(1);
    switch (first) {
      case "info":
        return runInfo(rest);
      case "git-setup":
        return runGitSetup(rest);
      case "git-verify":
        return runGitVerify(rest);
      case "git-driver":
        return gitDriverMain(rest);
    }
  }

  // Default: diff between two files.
  return runDiff(argv);
}

async function runDiff(argv: readonly string[]): Promise<number> {
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
    return handleError(e);
  }
}

async function runInfo(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let format: "text" | "json" | "canonical" = "text";
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--format" || args[i] === "-f") {
      const v = args[i + 1];
      if (v === "text" || v === "json" || v === "canonical") {
        format = v;
        args.splice(i, 2);
      } else {
        console.error(`flpdiff info: --format expects 'text' | 'json' | 'canonical'`);
        return EXIT_ERROR;
      }
    }
  }
  if (args.length !== 1) {
    console.error("Usage: flpdiff info <file.flp> [--format text|json|canonical]");
    return EXIT_ERROR;
  }
  const [path] = args as [string];

  try {
    const buf = await Bun.file(path).arrayBuffer();
    const project = parseFLPFile(buf);
    if (format === "json") {
      // sort_keys=True for byte-stable output, matching Python's
      // flp_diff.serialization.to_json.
      console.log(JSON.stringify(toFlpInfoJson(project), sortedReplacer, 2));
    } else if (format === "canonical") {
      // Use stdout.write to avoid double-newline — renderCanonical
      // already terminates with a trailing newline, and git's textconv
      // driver captures stdout verbatim.
      Bun.write(Bun.stdout, renderCanonical(project));
    } else {
      console.log(renderInfo(project, path));
    }
    return EXIT_IDENTICAL;
  } catch (e) {
    return handleError(e);
  }
}

/**
 * JSON replacer that emits objects with sorted keys (matches Python's
 * `json.dumps(..., sort_keys=True)`). Used for `--format=json` so output
 * is byte-stable across runs.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

function runGitSetup(argv: readonly string[]): number {
  const args = [...argv];
  let scope: Scope = "local";
  let mode: DriverMode = "command";
  let lfs = false;
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a === "--global") {
      args.splice(i, 1);
      scope = "global";
    } else if (a === "--textconv") {
      args.splice(i, 1);
      mode = "textconv";
    } else if (a === "--lfs") {
      args.splice(i, 1);
      lfs = true;
    }
  }
  if (args.length > 0) {
    console.error(`flpdiff git-setup: unexpected argument: ${args[0]}`);
    return EXIT_ERROR;
  }
  try {
    const result = setupGit({ scope, mode, lfs });
    const recap = renderSetupRecap(result);
    if (result.verified) {
      console.log(recap);
      return 0;
    }
    // Setup didn't verify — recap goes to stderr so exit-code-sensitive
    // callers don't mistake the text on stdout for success.
    Bun.write(Bun.stderr, recap + "\n");
    return EXIT_ERROR;
  } catch (e) {
    return handleError(e);
  }
}

function runGitVerify(argv: readonly string[]): number {
  if (argv.length > 0) {
    console.error(`flpdiff git-verify: unexpected argument: ${argv[0]}`);
    return EXIT_ERROR;
  }
  const result = verifyGit();
  const report = renderVerifyReport(result);
  if (result.status === "error") {
    Bun.write(Bun.stderr, report + "\n");
    return EXIT_ERROR;
  }
  console.log(report);
  return 0;
}

function handleError(e: unknown): number {
  if (e instanceof FLPParseError) {
    console.error(`flpdiff: parse error\n${e.message}`);
  } else if (e instanceof Error) {
    console.error(`flpdiff: ${e.message}`);
  } else {
    console.error(`flpdiff: ${String(e)}`);
  }
  return EXIT_ERROR;
}

// Entry-point guard. When imported for tests, do not auto-run.
if (import.meta.main) {
  const code = await run(Bun.argv.slice(2));
  process.exit(code);
}
