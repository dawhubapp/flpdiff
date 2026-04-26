# flpdiff

Semantic diff for FL Studio `.flp` project files — tempo changes,
renamed channels, moved clips, plugin swaps, mixer tweaks, per-note
edits. Clean-room parser in TypeScript. No Python, no Image-Line
tools needed.

```
$ flpdiff v1.flp v2.flp
FLP Diff: v1.flp vs v2.flp
──────────────────────────
Summary: 4 changes (2 channels, 1 mixer, 1 arrangements, 3 tracks)

Channels:
  ~ Channel sampler 'Kick' modified (1 changes)
      ~ Channel volume 78% → 100%
  + Added channel sampler 'Dub Vocal' (sample: vocals/dubmix.mp3)

Mixer:
  ~ Insert 8 (unnamed) modified (3 changes)
      + Insert renamed from unset to 'Dub Vocal'
      ~ Insert volume 100% → 71%
      + Insert color: unset → #5f7581

Arrangements:
  ~ Arrangement 'main' modified (0 arrangement changes, 3 track changes)
      ~ Track 'vocals' modified (10 changes)
          + 9 clips of 'Dub Vocal' added (length 5.854 beats, beats 62 … 206)
```

## Install

**Standalone binary** (no dependencies, no runtime):

Download the release for your platform from the [Releases page][releases]
and drop it on your `$PATH`:

```sh
# macOS (Apple Silicon)
curl -L https://github.com/pronskiy/flpdiff/releases/latest/download/flpdiff-darwin-arm64 -o /usr/local/bin/flpdiff
chmod +x /usr/local/bin/flpdiff

# macOS (Intel) → flpdiff-darwin-x64
# Linux (x64)   → flpdiff-linux-x64
# Linux (arm64) → flpdiff-linux-arm64
# Windows (x64) → flpdiff-windows-x64.exe
```

**Or via npm** (requires [Bun][bun] ≥ 1.3):

```sh
bun install -g flpdiff
# or, without installing globally:
bunx flpdiff A.flp B.flp
```

[releases]: https://github.com/pronskiy/flpdiff/releases
[bun]: https://bun.sh

## Commands

```
flpdiff [--verbose] [--color|--no-color] <A.flp> <B.flp>
                                            Semantic diff of two FLPs
flpdiff info <file.flp> [--format F]        Inspect a single FLP
                                              F ∈ text (default) | json | canonical
flpdiff git-setup [--global] [--textconv] [--lfs]
                                            Configure git to diff .flp files semantically
flpdiff git-verify                          Diagnose the current repo's flpdiff git setup
flpdiff git-driver <args>                   Internal: git external-diff entry
flpdiff --help | --version
```

Exit codes (for `flpdiff A.flp B.flp`): `0` identical, `1` differences found,
`2` parse / I/O error. Works in CI pipelines.

Colour is auto-enabled on TTY stdout and disabled when piped or when
`NO_COLOR` is set. Use `--color` / `--no-color` to force either way.
Only the top-level `+` / `-` / `~` markers are painted; sub-bullets and
headers stay in the terminal's default colour so long diffs don't read
like jelly-bean spew.

### `flpdiff info`

```sh
$ flpdiff info my_track.flp
File: my_track.flp
FL Studio 25.2.4.4960 | 145.0 BPM | 4/4 | PPQ 96
Title: Big Room Anthem
Artists: Roman Pronskiy
Channels: 12 (2 automations, 6 samplers, 4 instruments)
Patterns: 8
Mixer: 18 active inserts, 14 effect slots
Arrangements: 1 (500 tracks, 67 clips)
Plugins: Serum, Fruity Limiter, Fruity Parametric EQ 2, Sytrus, … and 4 more
Samples: 909 Kick.wav, Hat_closed.wav, vocal_chop_01.wav, … and 12 more
```

`--format json` emits the full project structure for scripting.
`--format canonical` is a deterministic line-oriented dump used
by the git textconv integration — stable across saves, per-entity.

### Git integration

Turn `.flp` files into first-class diffable content in any repo:

```sh
$ flpdiff git-setup
flpdiff git-setup (OK): scope=local, mode=command
  attributes: /path/to/repo/.gitattributes (updated)
  executable: /usr/local/bin/flpdiff
  $ git config --local diff.flp.command /usr/local/bin/flpdiff git-driver
  $ git config --local --unset diff.flp.textconv
  verify with: flpdiff git-verify
  try: git diff <changed.flp>
```

Once configured, **any** git command that normally shows diffs now
shows a semantic FLP diff instead of "Binary files differ":

```sh
git diff                    # after editing + saving an FLP in FL Studio
git diff HEAD~1 HEAD        # what changed in the last commit
git log -p my_track.flp     # full history
git show <sha>              # what a specific commit did
```

Options:

- `--global` writes to your global git config + global attributes file
  so every repo on your machine gets the FLP diff.
- `--textconv` uses git's native line-based diff on the canonical text
  output (cacheable, works well with git blame, slightly less rich
  than the default `command` mode).
- `--lfs` also tracks `*.flp` via [Git LFS][lfs] — useful for large
  sample-heavy projects. Implies repo-local scope.

Run `flpdiff git-verify` to sanity-check the current repo's setup
(checks you're inside a git repo, `.gitattributes` has the FLP rule,
`diff.flp.command` is set, and the configured binary executes).

#### Diffing two files not tracked in a repo

The `git diff` driver fires on **tracked changes** inside a repo. To
compare two arbitrary FLP files that aren't version-controlled, use
`git diff --no-index` (forces the two-file compare mode):

```sh
git diff --no-index v1.flp v2.flp
# or bypass git entirely:
flpdiff v1.flp v2.flp
```

[lfs]: https://git-lfs.com

## What's detected

- **Metadata**: tempo, title, artists, genre, URL, data-path changes.
- **Channels**: added / removed / renamed; volume / pan / color tweaks;
  plugin swaps (with vendor + VST hosting); sample-path changes;
  automation-curve keyframe deltas in musical units.
- **Patterns**: rename, length, looping, color, per-note edits
  (added / removed / moved / modified — with pitch labels like
  "C5 on channel 1 moved 1/2 beat later").
- **Mixer**: per-insert rename, color, volume, pan, stereo-separation,
  routing, enabled/locked toggles; per-slot plugin swaps with
  slot-position hints.
- **Arrangements**: track renames, per-clip add / remove / move / modify
  diffs with musical-unit shift descriptions, plus automatic collapse
  when a user nudged / duplicated / reshaped a run of similar clips
  ("9 clips of 'Dub Vocal' added (length 5.854 beats, beats 62 … 206)"
  instead of 9 near-identical lines).

Every change carries a pre-rendered human-readable label; the text
formatter and the JSON output render from the same underlying
`DiffResult`, so scripting consumers and human readers agree on what
happened.

## FL Studio version support

Tested against every FL major from 9 through 25, reproducing Python
`flpdiff`'s output byte-for-byte where available:

| FL version     | Parser (Pass 1) | flp-info JSON (Pass 2) |
|:---------------|:---------------:|:----------------------:|
| FL 9 – 24      | 100%            | 100%                   |
| FL 25 (current)| 100%            | 100%                   |

Covers 85 real-world projects spanning vocals, chord progressions,
drum chops, multi-bar arrangements, VST-heavy and native-only mixes.
One file is a known edge case where `flpdiff` is intentionally more
faithful than the reference Python tool (a VST vendor string we
extract but Python misses). See [`docs/parity-gaps.md`](docs/parity-gaps.md).

## How it works

`flpdiff` ships a clean-room FLP parser written from first principles
against direct byte inspection of FL Studio saves + the publicly
documented event-stream format. No code was copied from existing FLP
libraries; format facts were cross-checked only where legally distinct
from code reuse. The result is a small, fast, dependency-free parser
with no GPL lineage.

Built on [Bun][bun] + [typed-binary][tb] + TypeScript 6.

[tb]: https://github.com/iwoplaza/typed-binary

## Development

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the full development
story — phase-tracking, parity harnesses, format-spec contributions,
opcode catalog, and the clean-room boundary policy.

```sh
git clone https://github.com/pronskiy/flpdiff
cd flpdiff
bun install
bun test
```

During development, parity is verified against the reference
Python implementation via three harnesses (counts-and-kinds shape,
full `flp-info --format=json` byte-for-byte, and `flpdiff` rendered
text). They live in the dev-side `python/tools/parity/` of the
parent project and aren't part of this TS package — end users don't
need any of it.

## Contributing

Issues + PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

Bug reports: please include the FL Studio version that saved the file
(`flpdiff info <file>` shows it), the output of `flpdiff info --format=json`,
and — if you can share — the `.flp` itself or a minimal repro.

## License

[MIT](LICENSE). Copyright © 2026 Roman Pronskiy.
