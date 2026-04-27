# flpdiff

See what changed between two FL Studio `.flp` saves — channel by
channel, note by note.

[![npm version](https://img.shields.io/npm/v/flpdiff.svg)](https://www.npmjs.com/package/flpdiff)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![FL Studio 9–25](https://img.shields.io/badge/FL%20Studio-9%E2%80%9325-orange)

Every producer has this folder:

```
track_1.flp
track_2.flp
track_3_final.flp
track_3_final_2.flp
track_3_final_2_FINAL_real.flp
```

You saved them during a long session. A week later you open the
latest one, something feels off, and you want to go back — but back
to what? Which version had the bassline that worked? Which had the
EQ move that opened the mix? The files are binary. Opening two FL
Studio instances and squinting at 40 channels and 30 patterns isn't
happening. So you guess, start over, or live with the wrong version.

Or a collaborator sends back the project with "added some drums,
moved the breakdown." Git just says *Binary files differ.*

`flpdiff` reads both files and tells you, in plain English, exactly
what's different.

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

No FL Studio install needed. No Python. Just a small TypeScript binary
that knows the FLP format.

## Try it in 10 seconds

```sh
bunx flpdiff A.flp B.flp
```


## Install

**Standalone binary** — no runtime, no dependencies. Drop it on your
`$PATH`:

```sh
# macOS (Apple Silicon)
curl -L https://github.com/dawhubapp/flpdiff/releases/latest/download/flpdiff-darwin-arm64 -o /usr/local/bin/flpdiff
chmod +x /usr/local/bin/flpdiff

# macOS (Intel) → flpdiff-darwin-x64
# Linux (x64)   → flpdiff-linux-x64
# Linux (arm64) → flpdiff-linux-arm64
# Windows (x64) → flpdiff-windows-x64.exe
```

**Or via Bun:**

```sh
bun install -g flpdiff
```

[releases]: https://github.com/dawhubapp/flpdiff/releases
[bun]: https://bun.sh

## Two ways to use it

### 1. Side-by-side compare

```sh
flpdiff old.flp new.flp
```

Exit codes are CI-friendly: `0` if the projects are identical, `1`
if there are differences, `2` on parse or I/O errors. Pipe the
output, drop it in a build step, fail a PR check on unintended
plugin swaps — the usual.

### 2. As a `git diff` driver

You can save your FL Studio projects to Git and have a version control.

However, as .flp files are binary files, you will seeg *Binary files differ* on every `.flp` change. 

**flpdiff** in one command turns FLPs into first-class diffable content in any repo:

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

Once configured, every git command that normally shows diffs picks
up the FLP semantic diff:

```sh
git diff                    # after editing + saving an FLP in FL Studio
git diff HEAD~1 HEAD        # what changed in the last commit
git log -p my_track.flp     # full history
git show <sha>              # what a specific commit did
```

Add `--global` to wire it up for every repo on your machine, or
`--lfs` if your project tree lives in [Git LFS][lfs].

[lfs]: https://git-lfs.com

## What it picks up

Concrete, musician-friendly descriptions — not opcode dumps:

- **Project basics** — tempo, title, artists, genre, sample paths.
- **Channels** — added, removed, renamed; volume / pan / colour
  tweaks; plugin swaps with vendor info; automation-curve edits
  rendered in beats and bars.
- **Patterns** — rename, length, loop status, colour; per-note
  changes labelled musically ("C5 on channel 1 moved 1/2 beat
  later").
- **Mixer** — per-insert rename / colour / volume / pan / stereo
  separation / routing / enable / lock; per-slot plugin swaps with
  position hints.
- **Arrangements** — track renames; clip add / remove / move /
  modify in musical units; smart collapsing when you nudged a run
  of similar clips ("9 clips of 'Dub Vocal' added") instead of
  nine near-identical lines.

Every change carries a pre-rendered human label; the text and JSON
outputs render from the same `DiffResult`, so scripts and humans
agree on what happened.

## Inspect a single project

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

`flpdiff info <file> --format json` emits the full project
structure for scripting. `--format canonical` produces a stable,
line-oriented dump used by the git textconv integration.

## FL Studio compatibility

Tested across every FL major from 9 through 25, against 85 real-world
projects (vocals, chord progressions, drum chops, multi-bar
arrangements, VST-heavy and native-only mixes):

| FL version      | Parser | `info --format json` |
|:----------------|:------:|:--------------------:|
| FL 9 – 24       | 100%   | 100%                 |
| FL 25 (current) | 100%   | 100%                 |

## flpdiff and dawhub

`flpdiff` is the free, MIT-licensed CLI. If you'd rather drag two
`.flp` files onto a web page, share a link with a collaborator, or
keep version history in the cloud — that's [dawhub][dawhub], a
hosted product built on top of `flpdiff`. Same diff engine, browser
UI, plus collaboration. The CLI here stays free forever.

[dawhub]: https://dawhub.app

## How it works

`flpdiff` ships a clean-room FLP parser written from first principles
against direct byte inspection of FL Studio saves and the publicly
documented event-stream format. No code copied from existing FLP
libraries; format facts cross-checked only where legally distinct
from code reuse. The result is a small, fast, dependency-free parser
with no GPL lineage.

Built on [Bun][bun] + [typed-binary][tb] + TypeScript 6.

[tb]: https://github.com/iwoplaza/typed-binary

<details>
<summary><b>Full CLI reference</b></summary>

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

Colour auto-enables on TTY stdout and disables when piped or when
`NO_COLOR` is set. Use `--color` / `--no-color` to force either way.
Only top-level `+` / `-` / `~` markers get painted; sub-bullets and
headers stay neutral so long diffs don't read like jelly-bean spew.

To compare two FLPs that aren't tracked in any repo, use
`git diff --no-index v1.flp v2.flp` — or just `flpdiff v1.flp v2.flp`.

</details>

## Development

```sh
git clone https://github.com/dawhubapp/flpdiff
cd flpdiff
bun install
bun test
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the full
development story — phase tracking, parity harnesses, format-spec
contributions, opcode catalog, and the clean-room boundary policy.

## Acknowledgments

Huge thanks to [**PyFLP**](https://github.com/demberto/PyFLP) by
[@demberto](https://github.com/demberto) — an open-source
FL Studio project parser, written in Python. PyFLP is a thorough,
well-documented community effort and a real labour of love. `flpdiff`
is an independent clean-room TypeScript implementation, but
PyFLP set the bar and helped to make it possible.

## Contributing

Issues and PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

For bug reports: include the FL Studio version that saved the file
(`flpdiff info <file>` shows it), the JSON output of
`flpdiff info <file> --format json`, and — if you can share — the
`.flp` itself or a minimal repro.

## License

[MIT](LICENSE). Copyright © 2026 Roman Pronskiy.
