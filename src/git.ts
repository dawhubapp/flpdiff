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
  /**
   * Absolute path to the flpdiff binary baked into git config. When
   * `which flpdiff` fails, this falls back to the bare name `"flpdiff"`
   * — which git won't resolve at diff time. `notes` carries a loud
   * warning in that case.
   */
  executablePath: string;
  /**
   * True if setup verified the config was actually written after all
   * config commands ran. False means something went wrong silently
   * (usually: not in a git repo, or the git binary isn't on PATH).
   */
  verified: boolean;
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

  const notes: string[] = [];
  const exe =
    opts.executablePath ?? resolveFlpdiffExecutable((warning) => notes.push(warning));

  const configCommands: string[][] = [];
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

  // Post-write verification. Read back the key that matters most
  // (driver.flp.command for command mode, driver.flp.textconv for
  // textconv mode) and confirm it's present + matches what we wrote.
  // Catches the silent-failure case where git config writes no-op'd
  // because the CWD isn't inside a git repo.
  const verificationKey = `diff.${DRIVER_NAME}.${mode === "command" ? "command" : "textconv"}`;
  const verifyScope = scope === "global" ? "--global" : "--local";
  const verified = verifyConfigKey(verificationKey, verifyScope, repoRoot);
  if (!verified) {
    notes.push(
      `git-setup verification failed: \`git config ${verifyScope} --get ${verificationKey}\` returned nothing. ` +
        `Likely causes: (a) the target directory (${repoRoot}) isn't inside a git repo, ` +
        `(b) git is not installed or not on PATH, or ` +
        `(c) one of the git config commands above returned non-zero. ` +
        `Run \`flpdiff git-verify\` to diagnose.`,
    );
  }

  return {
    scope,
    mode,
    lfs,
    gitattributesPath,
    gitattributesTouched: touched,
    configCommands: configCommands.map((c) => [...c]),
    notes,
    executablePath: exe,
    verified,
  };
}

/**
 * Run `git config --get <key>` in the given scope + cwd. Returns true
 * if the key is set to a non-empty value, false otherwise. Used for
 * setupGit's post-write verification pass.
 */
function verifyConfigKey(key: string, scope: "--local" | "--global", cwd: string): boolean {
  const r = spawnSync("git", ["config", scope, "--get", key], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return false;
  return r.stdout.trim().length > 0;
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

/**
 * Resolve the absolute path to the `flpdiff` binary that git should
 * invoke at diff time. Strategy:
 *
 *   1. $PATH lookup via `which flpdiff`. Best outcome — absolute path
 *      that works regardless of git's eventual invocation environment.
 *   2. Check `process.argv[1]` — if the current process is itself
 *      `flpdiff`, we know where the binary lives without needing it
 *      on $PATH. Covers the "download binary to a local dir and
 *      run-setup-once" case.
 *   3. Fall back to the bare name `"flpdiff"` AND emit a loud
 *      warning via `warn` — git may not find it on its own PATH,
 *      which causes empty diffs with exit 0.
 */
function resolveFlpdiffExecutable(warn: (msg: string) => void): string {
  // 1. $PATH lookup.
  const which = spawnSync("which", ["flpdiff"], { encoding: "utf-8" });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) return found;
  }

  // 2. The currently-running flpdiff process (for standalone-binary users).
  const argv1 = process.argv[1];
  if (argv1 && argv1.endsWith("/flpdiff") && existsSync(argv1)) {
    warn(
      `\`flpdiff\` is not on PATH. Git config will point at the running binary (${argv1}). ` +
        `If you move or delete that file, re-run \`flpdiff git-setup\`. ` +
        `Recommended: symlink it onto your PATH, e.g. ` +
        `\`ln -s "${argv1}" ~/.local/bin/flpdiff\`.`,
    );
    return argv1;
  }

  // 3. Bare name — likely to fail when git invokes it.
  warn(
    "`flpdiff` is not on PATH and no usable absolute path could be resolved. " +
      "Git config will be written with the bare name `flpdiff`, which git will " +
      "probably fail to execute at diff time — leading to empty `git diff` output " +
      "with exit 0. Install flpdiff on PATH (e.g. `ln -s /path/to/flpdiff ~/.local/bin/`) " +
      "and re-run `flpdiff git-setup`.",
  );
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
// git-verify — sanity-check the current repo's flpdiff setup            //
// --------------------------------------------------------------------- //

export type VerifyStatus = "ok" | "warn" | "error";

export type VerifyCheck = {
  status: VerifyStatus;
  label: string;
  detail?: string;
};

export type VerifyResult = {
  /** Overall status: "error" if any check failed, else "warn" / "ok". */
  status: VerifyStatus;
  checks: readonly VerifyCheck[];
};

/**
 * Inspect the current repo's flpdiff setup and report what's actually
 * wired up. Used by `flpdiff git-verify` — complementary to setup,
 * which only knows what it *wrote* (not what git ended up seeing after
 * subsequent edits, stale config, PATH changes, etc.).
 *
 * Checks:
 *   - Inside a git repo? `git rev-parse --show-toplevel`
 *   - `.gitattributes` (local or global) has a `*.flp diff=flp` rule
 *   - `diff.flp.command` or `diff.flp.textconv` is set
 *   - The configured executable path is actually executable
 *   - The driver invokes successfully with `--version` (smoke)
 */
export function verifyGit(opts: { repoRoot?: string } = {}): VerifyResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const checks: VerifyCheck[] = [];

  // 1. Inside a git repo?
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const insideRepo = topLevel.status === 0 && topLevel.stdout.trim().length > 0;
  if (!insideRepo) {
    checks.push({
      status: "error",
      label: "current directory is inside a git repo",
      detail: `\`git rev-parse --show-toplevel\` exited ${topLevel.status} from ${repoRoot}. Run \`flpdiff git-verify\` from inside a repo.`,
    });
    return { status: "error", checks };
  }
  const repoTop = topLevel.stdout.trim();
  checks.push({
    status: "ok",
    label: "current directory is inside a git repo",
    detail: repoTop,
  });

  // 2. .gitattributes has a `*.flp diff=flp` rule (local OR global).
  const localAttrs = join(repoTop, ".gitattributes");
  const localHasRule = existsSync(localAttrs) && readFileSync(localAttrs, "utf-8").split(/\r?\n/).some((ln) => /^\*\.flp\s+.*\bdiff=flp\b/.test(ln.trim()));
  if (localHasRule) {
    checks.push({
      status: "ok",
      label: ".gitattributes: *.flp diff=flp rule present",
      detail: localAttrs,
    });
  } else {
    // Try global fallback.
    const globalR = spawnSync("git", ["config", "--global", "--get", "core.attributesfile"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let globalAttrs: string | null = null;
    if (globalR.status === 0 && globalR.stdout.trim()) {
      globalAttrs = expandHome(globalR.stdout.trim());
    } else {
      const xdg = process.env.XDG_CONFIG_HOME;
      const base = xdg ? xdg : join(homedir(), ".config");
      const candidate = join(base, "git", "attributes");
      if (existsSync(candidate)) globalAttrs = candidate;
    }
    const globalHasRule = globalAttrs !== null && existsSync(globalAttrs)
      && readFileSync(globalAttrs, "utf-8").split(/\r?\n/).some((ln) => /^\*\.flp\s+.*\bdiff=flp\b/.test(ln.trim()));
    if (globalHasRule) {
      checks.push({
        status: "ok",
        label: ".gitattributes: *.flp diff=flp rule present (global)",
        detail: globalAttrs!,
      });
    } else {
      checks.push({
        status: "error",
        label: ".gitattributes: *.flp diff=flp rule",
        detail: `Missing. Looked in ${localAttrs}${globalAttrs ? ` and ${globalAttrs}` : ""}. Run \`flpdiff git-setup\` (or \`--global\`).`,
      });
    }
  }

  // 3. diff.flp.{command,textconv} set?
  const cmd = readConfig("diff.flp.command", repoRoot);
  const textconv = readConfig("diff.flp.textconv", repoRoot);
  if (cmd) {
    checks.push({
      status: "ok",
      label: "git config: diff.flp.command",
      detail: cmd,
    });
  } else if (textconv) {
    checks.push({
      status: "ok",
      label: "git config: diff.flp.textconv (textconv mode)",
      detail: textconv,
    });
  } else {
    checks.push({
      status: "error",
      label: "git config: diff.flp.command or diff.flp.textconv",
      detail: "Neither is set. Run `flpdiff git-setup` or `flpdiff git-setup --textconv`.",
    });
  }

  // 4. Configured executable actually executes.
  const execStr = cmd ?? textconv;
  if (execStr) {
    // The configured value is a command line like
    // "/usr/local/bin/flpdiff git-driver" — split off first token.
    const firstToken = execStr.split(/\s+/)[0]!;
    const resolved = firstToken.startsWith("/") || firstToken.startsWith("~")
      ? expandHome(firstToken)
      : firstToken;
    const exists = resolved.startsWith("/") ? existsSync(resolved) : null;
    if (exists === false) {
      checks.push({
        status: "error",
        label: "flpdiff executable resolves",
        detail: `Configured path \`${resolved}\` does not exist. Re-run \`flpdiff git-setup\` from a terminal where \`flpdiff\` is on PATH.`,
      });
    } else {
      // Smoke test: invoke with --version.
      const v = spawnSync(firstToken, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      });
      if (v.status === 0 && v.stdout.trim().startsWith("flpdiff ")) {
        checks.push({
          status: "ok",
          label: "flpdiff executable runs",
          detail: v.stdout.trim(),
        });
      } else {
        checks.push({
          status: "warn",
          label: "flpdiff executable smoke test",
          detail: `\`${firstToken} --version\` exited ${v.status}. The configured path may work when git invokes it, but this check couldn't confirm.`,
        });
      }
    }
  }

  const anyError = checks.some((c) => c.status === "error");
  const anyWarn = checks.some((c) => c.status === "warn");
  return {
    status: anyError ? "error" : anyWarn ? "warn" : "ok",
    checks,
  };
}

function readConfig(key: string, cwd: string): string | null {
  // --local takes precedence over --global per git's merge rules; read
  // in that order and return the first non-empty value.
  for (const scope of ["--local", "--global"] as const) {
    const r = spawnSync("git", ["config", scope, "--get", key], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

export function renderVerifyReport(result: VerifyResult): string {
  const marker: Record<VerifyStatus, string> = {
    ok: "✓",
    warn: "!",
    error: "✗",
  };
  const lines: string[] = [];
  lines.push(`flpdiff git-verify: ${result.status === "ok" ? "OK" : result.status === "warn" ? "OK with warnings" : "problems found"}`);
  for (const c of result.checks) {
    lines.push(`  [${marker[c.status]}] ${c.label}`);
    if (c.detail) {
      for (const detailLine of c.detail.split("\n")) {
        lines.push(`        ${detailLine}`);
      }
    }
  }
  if (result.status === "error") {
    lines.push("");
    lines.push("Common fixes:");
    lines.push("  - `flpdiff git-setup`                   configure this repo");
    lines.push("  - `flpdiff git-setup --global`          configure all your repos");
    lines.push("  - `flpdiff git-setup --textconv`        use git's native diff on canonical text");
    lines.push("  - `flpdiff git-setup --lfs`             also track *.flp with Git LFS");
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------- //
// Recap formatter — human-friendly summary of what setupGit did         //
// --------------------------------------------------------------------- //

export function renderSetupRecap(result: SetupResult): string {
  const lines: string[] = [];
  const statusTag = result.verified ? "OK" : "FAILED";
  lines.push(
    `flpdiff git-setup (${statusTag}): scope=${result.scope}, mode=${result.mode}` +
      (result.lfs ? ", lfs=on" : ""),
  );
  if (result.gitattributesPath) {
    const verb = result.gitattributesTouched ? "updated" : "already configured";
    lines.push(`  attributes: ${result.gitattributesPath} (${verb})`);
  }
  lines.push(`  executable: ${result.executablePath}`);
  for (const cmd of result.configCommands) {
    lines.push(`  $ ${cmd.join(" ")}`);
  }
  for (const note of result.notes) {
    lines.push(`  note: ${note}`);
  }
  if (result.verified && result.scope === "local" && result.mode === "command") {
    lines.push("  verify with: flpdiff git-verify");
    lines.push("  try: git diff <changed.flp>");
  } else if (!result.verified) {
    lines.push("  next: run `flpdiff git-verify` to diagnose");
  }
  return lines.join("\n");
}
