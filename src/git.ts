/**
 * Git integration — external diff driver + `git-setup` command.
 *
 * Ports Python's `flp_diff.git_integration` adapted to the single-
 * binary TS world: `flpdiff git-driver` is the entry Git invokes via
 * `diff.flp.command`, and `flpdiff git-setup` writes `.gitattributes`
 * + git config so `git diff *.flp` produces semantic output.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { parseFLPFile } from "./parser/flp-project.ts";
import { FLPParseError } from "./parser/errors.ts";
import { compareProjects } from "./diff/comparator.ts";
import { renderSummary } from "./diff/summary.ts";

/** `diff=<name>` token used in .gitattributes + [diff "<name>"] in config. */
export const DRIVER_NAME = "flp";
export const GIT_ATTRIBUTE_LINE = `*.flp diff=${DRIVER_NAME}`;
export const GIT_LFS_ATTRIBUTE_LINE = `*.flp filter=lfs diff=${DRIVER_NAME} merge=lfs -text`;

// --------------------------------------------------------------------- //
// External diff driver entry point                                      //
// --------------------------------------------------------------------- //

/**
 * Entry point for `flpdiff git-driver <args>`. Git invokes our binary
 * with either 7 or 9 positional args (standard external-diff convention
 * + rename-like form). We care only about `old-file` (args[1]) and
 * `new-file` (args[4]) in both shapes.
 *
 * Returns 0 on success, 2 on parse/arg-shape failure.
 */
export async function gitDriverMain(argv: readonly string[]): Promise<number> {
  if (argv.length !== 7 && argv.length !== 9) {
    console.error(
      `flpdiff git-driver: expected 7 or 9 args (git external-diff convention), got ${argv.length}: ${JSON.stringify(argv)}`,
    );
    return 2;
  }

  const path = argv[0]!;
  const oldFile = argv[1]!;
  const newFile = argv[4]!;

  try {
    const [oldBuf, newBuf] = await Promise.all([
      Bun.file(oldFile).arrayBuffer(),
      Bun.file(newFile).arrayBuffer(),
    ]);
    const oldProject = parseFLPFile(oldBuf);
    const newProject = parseFLPFile(newBuf);
    const result = compareProjects(oldProject, newProject);
    // No title — git prepends its own `diff --git a/… b/…` header.
    console.log(renderSummary(result));
    return 0;
  } catch (e) {
    const msg = e instanceof FLPParseError ? e.message : e instanceof Error ? e.message : String(e);
    console.error(`flpdiff git-driver: failed to parse (${path}): ${msg}`);
    return 2;
  }
}

// --------------------------------------------------------------------- //
// git-setup — configure repo or global git for FLP semantic diff        //
// --------------------------------------------------------------------- //

export type Scope = "local" | "global";
export type DriverMode = "command" | "textconv";

export type SetupOptions = {
  scope?: Scope;
  mode?: DriverMode;
  lfs?: boolean;
  /** Override repo root (tests). Defaults to cwd. */
  repoRoot?: string;
  /** Override global attributes path (tests). */
  globalAttributesPath?: string;
  /** Override subprocess runner (tests). Returns exit code. */
  runner?: (cmd: readonly string[]) => number;
  /** Override the flpdiff executable path baked into git config. Tests pass a stable value. */
  executablePath?: string;
};

export type SetupResult = {
  scope: Scope;
  mode: DriverMode;
  lfs: boolean;
  gitattributesPath: string | null;
  gitattributesTouched: boolean;
  configCommands: readonly (readonly string[])[];
  notes: readonly string[];
};

/**
 * Configure git for FLP semantic diff. Writes .gitattributes (repo
 * `scope="local"`) or the global attributes file (`scope="global"`)
 * and edits git config via `git config --local` / `--global`.
 *
 * `mode="command"`: external diff driver (rich output via git-driver).
 * `mode="textconv"`: git native diff on canonical text (cacheable).
 * `lfs=true`: adds LFS filter line (implies local scope).
 */
export function setupGit(opts: SetupOptions = {}): SetupResult {
  const scope: Scope = opts.scope ?? "local";
  const mode: DriverMode = opts.mode ?? "command";
  const lfs = opts.lfs ?? false;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const runner = opts.runner ?? defaultRunner;
  const exe = opts.executablePath ?? resolveFlpdiffExecutable();

  const configCommands: string[][] = [];
  const notes: string[] = [];
  const base = ["git", "config", scope === "global" ? "--global" : "--local"];

  // Driver config (command vs textconv).
  if (mode === "command") {
    configCommands.push([...base, `diff.${DRIVER_NAME}.command`, `${exe} git-driver`]);
    configCommands.push([...base, "--unset", `diff.${DRIVER_NAME}.textconv`]);
  } else {
    configCommands.push([
      ...base,
      `diff.${DRIVER_NAME}.textconv`,
      `${exe} info --format=canonical`,
    ]);
    configCommands.push([...base, `diff.${DRIVER_NAME}.cachetextconv`, "true"]);
    configCommands.push([...base, "--unset", `diff.${DRIVER_NAME}.command`]);
  }

  // Attributes file.
  let gitattributesPath: string | null = null;
  let touched = false;
  if (scope === "local") {
    gitattributesPath = join(repoRoot, ".gitattributes");
    touched = ensureGitattributes(gitattributesPath, lfs);
  } else {
    gitattributesPath = resolveGlobalAttributesPath(opts.globalAttributesPath, runner);
    mkdirSync(dirname(gitattributesPath), { recursive: true });
    touched = ensureGitattributes(gitattributesPath, false);
    configCommands.push([...base, "core.attributesfile", gitattributesPath]);
    if (lfs) {
      notes.push(
        "LFS tracking is per-repo and cannot be configured in --global scope; rerun `flpdiff git-setup --lfs` inside the repo.",
      );
    }
  }

  // Execute config commands.
  for (const cmd of configCommands) {
    const rc = runner(cmd);
    if (rc !== 0 && cmd[3] !== "--unset") {
      notes.push(`git config failed: ${cmd.join(" ")} (exit ${rc})`);
    }
  }

  // LFS install + track (local only).
  if (lfs && scope === "local") {
    const installRc = runner(["git", "lfs", "install", "--local"]);
    if (installRc === 0) {
      runner(["git", "lfs", "track", "*.flp"]);
    } else {
      notes.push(
        "git-lfs not available — install https://git-lfs.com and rerun `flpdiff git-setup --lfs`.",
      );
    }
  }

  return {
    scope,
    mode,
    lfs,
    gitattributesPath,
    gitattributesTouched: touched,
    configCommands: configCommands.map((c) => [...c]),
    notes,
  };
}

/**
 * Append the FLP rule to `.gitattributes` (or equivalent) if absent.
 * Strips any stale `*.flp` rule first so upgrading from `diff=flp` to
 * the LFS triple (or vice versa) doesn't leave conflicting lines.
 * Returns true when the file was created or modified.
 */
export function ensureGitattributes(path: string, lfs: boolean): boolean {
  const target = lfs ? GIT_LFS_ATTRIBUTE_LINE : GIT_ATTRIBUTE_LINE;
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const existingLines = existing.split(/\r?\n/);
  if (existingLines.some((ln) => ln.trim() === target)) return false;

  const filtered = existingLines.filter((ln) => !isFlpRule(ln));
  // Drop trailing empties left over from split; preserve a blank-line
  // separator if the file already had other rules.
  while (filtered.length > 0 && filtered[filtered.length - 1]!.trim() === "") {
    filtered.pop();
  }
  if (filtered.length > 0) filtered.push("");
  filtered.push(target);
  writeFileSync(path, filtered.join("\n") + "\n", "utf-8");
  return true;
}

function isFlpRule(line: string): boolean {
  const stripped = line.trim();
  return stripped.startsWith("*.flp ") || stripped.startsWith("*.flp\t");
}

function resolveFlpdiffExecutable(): string {
  // Best-effort resolution of the flpdiff bin the user invoked:
  //   1. $PATH lookup via `which flpdiff`
  //   2. fall back to the bare name (user's PATH will be in git's env).
  const which = spawnSync("which", ["flpdiff"], { encoding: "utf-8" });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) return found;
  }
  return "flpdiff";
}

function resolveGlobalAttributesPath(
  explicit: string | undefined,
  runner: (cmd: readonly string[]) => number,
): string {
  if (explicit !== undefined) return explicit;
  // Respect existing core.attributesfile if already set.
  const r = spawnSync("git", ["config", "--global", "--get", "core.attributesfile"], {
    encoding: "utf-8",
  });
  if (r.status === 0 && r.stdout.trim()) {
    return expandHome(r.stdout.trim());
  }
  // Fall back to git's documented default: $XDG_CONFIG_HOME/git/attributes.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : join(homedir(), ".config");
  return join(base, "git", "attributes");
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function defaultRunner(cmd: readonly string[]): number {
  // Suppress stderr for --unset — missing keys aren't errors.
  const suppress = cmd.length > 3 && cmd[3] === "--unset";
  const r: SpawnSyncReturns<Buffer> = spawnSync(cmd[0]!, cmd.slice(1), {
    stdio: ["ignore", "ignore", suppress ? "ignore" : "inherit"],
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return 127;
  return r.status ?? 127;
}

// --------------------------------------------------------------------- //
// Recap formatter — human-friendly summary of what setupGit did         //
// --------------------------------------------------------------------- //

export function renderSetupRecap(result: SetupResult): string {
  const lines: string[] = [];
  lines.push(
    `flpdiff git-setup: scope=${result.scope}, mode=${result.mode}` +
      (result.lfs ? ", lfs=on" : ""),
  );
  if (result.gitattributesPath) {
    const verb = result.gitattributesTouched ? "updated" : "already configured";
    lines.push(`  attributes: ${result.gitattributesPath} (${verb})`);
  }
  for (const cmd of result.configCommands) {
    lines.push(`  $ ${cmd.join(" ")}`);
  }
  for (const note of result.notes) {
    lines.push(`  note: ${note}`);
  }
  if (result.scope === "local" && result.mode === "command") {
    lines.push("  try: git diff <changed.flp>");
  }
  return lines.join("\n");
}
