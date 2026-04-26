import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import {
  setupGit,
  ensureGitattributes,
  GIT_ATTRIBUTE_LINE,
  GIT_LFS_ATTRIBUTE_LINE,
  renderSetupRecap,
  gitDriverMain,
  DRIVER_NAME,
} from "../src/index.ts";
import { run } from "../src/cli.ts";

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("ensureGitattributes", () => {
  test("creates .gitattributes with the default FLP rule", () => {
    const dir = mkTmp("flpdiff-gitattr-");
    const path = join(dir, ".gitattributes");
    const touched = ensureGitattributes(path, false);
    expect(touched).toBe(true);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain(GIT_ATTRIBUTE_LINE);
    expect(content.endsWith("\n")).toBe(true);
  });

  test("idempotent: second call on identical file returns false (no rewrite)", () => {
    const dir = mkTmp("flpdiff-gitattr-");
    const path = join(dir, ".gitattributes");
    expect(ensureGitattributes(path, false)).toBe(true);
    expect(ensureGitattributes(path, false)).toBe(false);
  });

  test("upgrades diff=flp → LFS triple without leaving conflicting lines", () => {
    const dir = mkTmp("flpdiff-gitattr-");
    const path = join(dir, ".gitattributes");
    writeFileSync(path, `${GIT_ATTRIBUTE_LINE}\n`);
    ensureGitattributes(path, true);
    const content = readFileSync(path, "utf-8");
    // The LFS triple should be present, the old plain rule should not.
    expect(content).toContain(GIT_LFS_ATTRIBUTE_LINE);
    expect(content.split(/\r?\n/).filter((l) => l === GIT_ATTRIBUTE_LINE)).toEqual([]);
  });

  test("preserves existing unrelated rules", () => {
    const dir = mkTmp("flpdiff-gitattr-");
    const path = join(dir, ".gitattributes");
    writeFileSync(path, "*.png -text\n");
    ensureGitattributes(path, false);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("*.png -text");
    expect(content).toContain(GIT_ATTRIBUTE_LINE);
  });
});

describe("setupGit — local scope with swapped runner", () => {
  test("local command mode records the right git config commands", () => {
    const dir = mkTmp("flpdiff-setup-");
    const commands: string[][] = [];
    const result = setupGit({
      scope: "local",
      mode: "command",
      repoRoot: dir,
      runner: (cmd) => {
        commands.push([...cmd]);
        return 0;
      },
      executablePath: "/usr/local/bin/flpdiff",
    });
    expect(result.scope).toBe("local");
    expect(result.mode).toBe("command");
    expect(result.gitattributesPath).toBe(join(dir, ".gitattributes"));
    expect(result.gitattributesTouched).toBe(true);
    // Should set diff.flp.command and unset diff.flp.textconv.
    const joined = commands.map((c) => c.join(" "));
    expect(joined).toContain(`git config --local diff.${DRIVER_NAME}.command /usr/local/bin/flpdiff git-driver`);
    expect(joined).toContain(`git config --local --unset diff.${DRIVER_NAME}.textconv`);
    // .gitattributes should contain the plain rule.
    expect(readFileSync(join(dir, ".gitattributes"), "utf-8")).toContain(GIT_ATTRIBUTE_LINE);
  });

  test("textconv mode wires `info --format=canonical` + cachetextconv=true", () => {
    const dir = mkTmp("flpdiff-setup-");
    const commands: string[][] = [];
    setupGit({
      scope: "local",
      mode: "textconv",
      repoRoot: dir,
      runner: (cmd) => {
        commands.push([...cmd]);
        return 0;
      },
      executablePath: "/usr/local/bin/flpdiff",
    });
    const joined = commands.map((c) => c.join(" "));
    expect(joined).toContain(
      `git config --local diff.${DRIVER_NAME}.textconv /usr/local/bin/flpdiff info --format=canonical`,
    );
    expect(joined).toContain(`git config --local diff.${DRIVER_NAME}.cachetextconv true`);
    expect(joined).toContain(`git config --local --unset diff.${DRIVER_NAME}.command`);
  });

  test("lfs=true writes the LFS triple and runs `git lfs install`", () => {
    const dir = mkTmp("flpdiff-setup-");
    const commands: string[][] = [];
    setupGit({
      scope: "local",
      mode: "command",
      lfs: true,
      repoRoot: dir,
      runner: (cmd) => {
        commands.push([...cmd]);
        return 0;
      },
      executablePath: "/usr/local/bin/flpdiff",
    });
    expect(readFileSync(join(dir, ".gitattributes"), "utf-8")).toContain(GIT_LFS_ATTRIBUTE_LINE);
    const joined = commands.map((c) => c.join(" "));
    expect(joined).toContain("git lfs install --local");
    expect(joined).toContain("git lfs track *.flp");
  });
});

describe("setupGit — global scope", () => {
  test("writes to the provided global attributes path + sets core.attributesfile", () => {
    const homedir = mkTmp("flpdiff-home-");
    const attributesPath = join(homedir, "config", "git", "attributes");
    const commands: string[][] = [];
    const result = setupGit({
      scope: "global",
      mode: "command",
      globalAttributesPath: attributesPath,
      runner: (cmd) => {
        commands.push([...cmd]);
        return 0;
      },
      executablePath: "/usr/local/bin/flpdiff",
    });
    expect(result.scope).toBe("global");
    expect(result.gitattributesPath).toBe(attributesPath);
    expect(existsSync(attributesPath)).toBe(true);
    const joined = commands.map((c) => c.join(" "));
    expect(joined).toContain(`git config --global core.attributesfile ${attributesPath}`);
  });

  test("lfs note fires in global scope (LFS is per-repo)", () => {
    const dir = mkTmp("flpdiff-home-");
    const result = setupGit({
      scope: "global",
      mode: "command",
      lfs: true,
      globalAttributesPath: join(dir, "attributes"),
      runner: () => 0,
      executablePath: "/usr/local/bin/flpdiff",
    });
    expect(result.notes.some((n) => n.includes("LFS tracking is per-repo"))).toBe(true);
  });
});

describe("renderSetupRecap", () => {
  test("prints OK status + scope + mode + path + commands + next-step hint", () => {
    const r = renderSetupRecap({
      scope: "local",
      mode: "command",
      lfs: false,
      gitattributesPath: "/tmp/x/.gitattributes",
      gitattributesTouched: true,
      configCommands: [["git", "config", "--local", "diff.flp.command", "/usr/bin/flpdiff git-driver"]],
      notes: [],
      executablePath: "/usr/bin/flpdiff",
      verified: true,
    });
    expect(r).toContain("(OK)");
    expect(r).toContain("scope=local, mode=command");
    expect(r).toContain("/tmp/x/.gitattributes (updated)");
    expect(r).toContain("executable: /usr/bin/flpdiff");
    expect(r).toContain("$ git config --local diff.flp.command /usr/bin/flpdiff git-driver");
    expect(r).toContain("try: git diff");
  });

  test("reports FAILED + hint to git-verify when setup didn't verify", () => {
    const r = renderSetupRecap({
      scope: "local",
      mode: "command",
      lfs: false,
      gitattributesPath: "/tmp/x/.gitattributes",
      gitattributesTouched: true,
      configCommands: [["git", "config", "--local", "diff.flp.command", "flpdiff git-driver"]],
      notes: ["git-setup verification failed: …"],
      executablePath: "flpdiff",
      verified: false,
    });
    expect(r).toContain("(FAILED)");
    expect(r).toContain("note: git-setup verification failed:");
    expect(r).toContain("run `flpdiff git-verify`");
    expect(r).not.toContain("try: git diff");
  });
});

describe("gitDriverMain — external-diff protocol shape", () => {
  const CORPUS = resolve(import.meta.dir, "../../tests/corpus/re_base/fl25");
  const BASE = join(CORPUS, "base_empty.flp");

  test("rejects arg count that isn't 7 or 9", async () => {
    const code = await gitDriverMain(["one", "two", "three"]);
    expect(code).toBe(2);
  });

  test("returns 0 when the two files parse", async () => {
    const code = await gitDriverMain([
      // path, old-file, old-hex, old-mode, new-file, new-hex, new-mode
      "base_empty.flp",
      BASE,
      "0".repeat(40),
      "100644",
      BASE,
      "0".repeat(40),
      "100644",
    ]);
    expect(code).toBe(0);
  });

  test("returns 2 when a file can't be parsed", async () => {
    const bogus = join(mkTmp("flpdiff-bogus-"), "bogus.flp");
    writeFileSync(bogus, new Uint8Array([0, 1, 2, 3]));
    const code = await gitDriverMain([
      "bogus.flp",
      bogus,
      "0".repeat(40),
      "100644",
      bogus,
      "0".repeat(40),
      "100644",
    ]);
    expect(code).toBe(2);
  });
});

describe("CLI — git-setup + git-driver subcommand dispatch", () => {
  test("flpdiff git-driver forwards to the driver entry", async () => {
    // Exit 2 since no args passed.
    const code = await run(["git-driver"]);
    expect(code).toBe(2);
  });

  test("flpdiff git-setup rejects unknown args", async () => {
    const code = await run(["git-setup", "--nonsense"]);
    expect(code).toBe(2);
  });

  test("flpdiff git-verify rejects unknown args", async () => {
    const code = await run(["git-verify", "--nonsense"]);
    expect(code).toBe(2);
  });
});

// --------------------------------------------------------------------- //
// verifyGit — post-install sanity check                                 //
// --------------------------------------------------------------------- //

import { verifyGit, renderVerifyReport } from "../src/git.ts";
import { execSync } from "node:child_process";

function initRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config --local user.email you@example.com", { cwd: dir });
  execSync("git config --local user.name you", { cwd: dir });
}

describe("verifyGit", () => {
  test("reports error when not in a git repo", () => {
    const dir = mkTmp("flpdiff-verify-");
    const result = verifyGit({ repoRoot: dir });
    expect(result.status).toBe("error");
    const firstCheck = result.checks[0]!;
    expect(firstCheck.status).toBe("error");
    expect(firstCheck.label).toContain("inside a git repo");
  });

  test("detects a fresh repo + produces structured checks", () => {
    const dir = mkTmp("flpdiff-verify-");
    initRepo(dir);
    const result = verifyGit({ repoRoot: dir });
    // `status` depends on whether the host has global flpdiff config
    // (CI may or may not, and the fallback is legitimate behaviour —
    // it's how `git-setup --global` works). Assert structure only.
    expect(result.checks.length).toBeGreaterThanOrEqual(2);
    const repoCheck = result.checks.find((c) => c.label.includes("inside a git repo"))!;
    expect(repoCheck.status).toBe("ok");
    const labels = result.checks.map((c) => c.label);
    expect(labels.some((l) => l.includes(".gitattributes"))).toBe(true);
    expect(labels.some((l) => l.includes("diff.flp"))).toBe(true);
  });

  test("reports ok after a real setupGit call with an absolute binary path", () => {
    const dir = mkTmp("flpdiff-verify-");
    initRepo(dir);
    // Fake a binary at a stable path so verify's executable check
    // has something to find. We use `echo` — it exists on every
    // POSIX system and the --version smoke test will fail (not
    // an "ok" status), so we expect "warn" overall, not "ok".
    setupGit({
      scope: "local",
      mode: "command",
      repoRoot: dir,
      runner: (cmd) => {
        // Actually apply config to THIS repo. Mirror defaultRunner's
        // behaviour: --unset is allowed to fail on missing keys.
        const suppress = cmd.length > 3 && cmd[3] === "--unset";
        try {
          execSync(cmd.map((a) => JSON.stringify(a)).join(" "), { cwd: dir, stdio: "ignore" });
          return 0;
        } catch {
          return suppress ? 0 : 1;
        }
      },
      executablePath: "/bin/echo",
    });
    const result = verifyGit({ repoRoot: dir });
    // /bin/echo exists but `echo --version` doesn't start with
    // "flpdiff " — so smoke test is "warn". Overall status: warn.
    expect(["warn", "ok"]).toContain(result.status);
    const labels = result.checks.map((c) => c.label);
    expect(labels.some((l) => l.includes("rule present"))).toBe(true);
    expect(labels.some((l) => l.includes("diff.flp.command"))).toBe(true);
  });

  test("renderVerifyReport surfaces markers + fix suggestions on error", () => {
    const report = renderVerifyReport({
      status: "error",
      checks: [
        { status: "error", label: "inside a git repo", detail: "not found" },
      ],
    });
    expect(report).toContain("[✗] inside a git repo");
    expect(report).toContain("problems found");
    expect(report).toContain("Common fixes:");
    expect(report).toContain("`flpdiff git-setup`");
  });

  test("renderVerifyReport shows OK on clean result", () => {
    const report = renderVerifyReport({
      status: "ok",
      checks: [{ status: "ok", label: "all good", detail: "yep" }],
    });
    expect(report).toContain("git-verify: OK");
    expect(report).toContain("[✓] all good");
    expect(report).not.toContain("Common fixes:");
  });
});
