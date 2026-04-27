# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] — 2026-04-27

### Fixed

- `flpdiff --version` now reports the actual package version. Prior
  releases returned a hardcoded `0.1.0` regardless of the installed
  version because the CLI's `VERSION` constant was inlined. The CLI
  now reads it from `package.json` at startup, so future bumps stay
  in sync automatically.

## [0.1.1] — 2026-04-27

### Changed

- npm package description tightened. No code changes from 0.1.0;
  this version refreshes the registry metadata.

## [0.1.0] — 2026-04-20

Initial public release.

### Added

- **Clean-room FLP parser** for FL Studio `.flp` project files.
  Written in TypeScript from direct byte inspection + published format
  knowledge. Covers FL Studio 9 through 25 (latest).
- **`flpdiff A.flp B.flp`** — semantic diff CLI with text output
  (default), verbose mode, and structured `DiffResult` under the hood.
  Exit codes 0 (identical) / 1 (differences) / 2 (error).
- **`flpdiff info FILE [--format text|json|canonical]`** — single-file
  inspection. `json` format is the full project structure; `canonical`
  is a deterministic line-oriented dump (used by git textconv).
- **Git integration**:
  - `flpdiff git-setup [--global] [--textconv] [--lfs]` — configures
    `.gitattributes` + git config so `git diff *.flp` produces semantic
    output. Works with Git LFS. Verifies the config landed before
    exiting; `FAILED` status + stderr exit-2 on silent-failure modes.
  - `flpdiff git-verify` — diagnose the current repo's setup (inside
    a git repo? attributes rule present? driver configured? binary
    resolves and runs?). Useful after moving the binary, changing
    PATH, or when `git diff` gives unexpected empty output.
  - `flpdiff git-driver` — external-diff protocol entry (invoked by
    git, not directly by users).
- **Clip-collapse grouping**: when a user nudges / duplicates /
  reshapes a run of 3+ same-ref clips on one playlist track, the diff
  renders one summary line per group instead of N near-identical lines.
  Three collapse types: move (uniform shift), bulk (add/remove run),
  modify (length/muted at fixed position). Each group keeps the
  per-clip changes around for JSON consumers + `--verbose`.
- **Per-note diff** inside patterns with musical-unit shift labels
  ("C5 on channel 1 moved 1/2 beat later") and automatic bucket
  summarisation at > 10 notes per pattern.
- **Automation-curve diff** on automation-clip channels + pattern
  controllers: per-keyframe add / remove / modify changes in
  timeline order.
- **Plugin identity**: VST vs native distinction, vendor extraction,
  swap labels (`Plugin swapped in slot 2: 'Serum' (Xfer Records, VST)
  → Fruity DX10`).
- **Standalone binaries** for darwin-arm64, darwin-x64, linux-x64,
  linux-arm64, windows-x64 — no runtime required on the target machine.

### Parity with reference Python `flpdiff`

This TypeScript implementation was developed alongside a Python
reference to validate its output. Validation results on an 85-file
personal corpus spanning FL 9 through 25:

- **Counts-and-kinds shape**: 85 / 85 identical across every FL version.
- **Full `flp-info --format=json` byte-for-byte**: 83 / 85 (one VST
  wrapper edge case where TS is intentionally more faithful; one file
  the reference Python tool cannot parse).
- **Rendered diff text vs reference**: MD5-identical output on 5 of 6
  real-world diff pairs; the 6th is the same VST-vendor edge case.

[Unreleased]: https://github.com/dawhubapp/flpdiff/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/dawhubapp/flpdiff/releases/tag/v0.1.2
[0.1.1]: https://github.com/dawhubapp/flpdiff/releases/tag/v0.1.1
[0.1.0]: https://github.com/dawhubapp/flpdiff/releases/tag/v0.1.0
