# flpdiff-ts

TypeScript port of [flpdiff](https://github.com/pronskiy/flpdiff).

**Status:** Phase 3.1 (scaffold) ✅, Phase 3.2 (headline MVP) ✅, Phase 3.3
(entities) 🔄 at comprehensive coverage across all six sub-phases, with
3.3.6 (oracle harness) ✅. Phase 3.4 (diff engine port) **deferred pending
confirmation** — the parser now covers enough entity metadata for
meaningful diffs but no matching/comparator code has been written yet.

**Current state:** 155 tests green, 3934 assertions, tsc clean, on
TypeScript 6 + Bun 1.3.9 + typed-binary 4.3.3.

- **5/5 public FL 25 fixtures** — hand-crafted oracle via
  `buildProjectSummary(project)`.
- **85/85 local corpus — Pass 1** (counts-and-kinds shape), every FL
  version 9 through 25 at 100%.
- **75/85 local corpus — Pass 2** (full `flp-info --format=json`
  byte-for-byte with 1e-4 float tolerance) via the new TS
  presentation layer at `src/presentation/flp-info.ts`. Remaining 10
  drift files are all FL 9 edge cases (Python's coarser event-subtree
  division attributes mixer-section 0xCB/0xCC differently) plus one
  FL 20 plugin.vendor case (Python misses a vendor we correctly
  extract — arguably our behaviour is more faithful).

This repo is a nested git repo alongside the main Python `flpdiff`
codebase. It exists to explore two asymmetric wins that Python cannot
deliver cheaply:

1. **Clean-room FLP parser** — no dependency on the reference parser (GPL-3 reference),
   .
2. **Browser-native diff viewer** — `.flp` files parsed and diffed
   entirely in the browser, no install.

Python remains the canonical product and continues to ship on its own
schedule. This port has an explicit go/no-go gate at Phase 3.6 before
any production commitment is made. See the spec
 for the full plan and exit guardrails.

## Principles

- **No the reference parser source referenced** during parser development. Format
  knowledge derives from `docs/flp-format-spec.md`, the dev repo's
  harness notes, and direct byte inspection of committed fixtures.
  the reference parser has been cross-checked a handful of times for **format facts
  only** (never code); see the per-commit rationale and the "Clean-room
  cross-checks" list in the auto-memory file
  `project_epic_3_phase_3_1_3_2.md`.
- **Oracle testing** against Python's `flp-info --format json` is the
  correctness check. All five FL 25 public fixtures match on every
  decoded field (header, channels, patterns, inserts, arrangements).
- **Byte-offset error context from day one.** Every custom
  `Schema.read()` is wrapped in `annotateRead` — malformed FLPs produce
  errors with absolute byte offset, schema name, opcode, event index,
  nesting path, and a 16-byte hex-dump of preceding bytes. Not
  retrofitted.
- **Four self-discovered FL 25 opcode relocations** documented in
  `docs/flp-format-spec.md`: `0xEE` (track data from the reference parser's `0xDE`),
  `0xE0` (pattern notes from `0xD0`), `0xDB` (channel Levels from
  `0xCB`/`0xCF` overload), and `0xEC` (insert flags from `0xDC`). All
  four fit the same `DATA + 16` offset pattern.
- **Parity-harness-driven corrections.** Running the Pass 1 parity
  harness (`tools/parity/run_parity.py`) against the 85-file local
  corpus caught three opcode mis-readings that the 5 public fixtures
  never exercised, plus a handful of walker-scope and legacy-layout
  bugs — see the "Parity harness" section below.
- **Bun** is the runtime and test runner. **typed-binary** handles TLV
  event parsing via three custom `Schema<T>` subclasses.

## Quickstart

```sh
bun install
bun test
bun run cli path/to/A.flp path/to/B.flp
```

Expected `cli` output when headlines match:
```
No headline changes.
```
When they differ (e.g. tempo change):
```
~ Tempo: 120.0 BPM → 145.0 BPM
```

Exit codes: `0` identical, `1` differences found, `2` parse/I/O error.

## What the parser currently decodes

`parseFLPFile(buffer)` returns an `FLPProject` with:

```ts
{
  header:   { format, n_channels, ppq },
  events:   FLPEvent[],          // raw TLV events (4 kinds)
  channels: Channel[],
  inserts:  MixerInsert[],
  patterns: Pattern[],
  arrangements: Arrangement[],
}
```

Per-entity fields (all optional; populated when the corresponding
opcode is present):

| Entity      | Fields |
|-------------|--------|
| Channel     | iid, kind, name, sample_path, plugin (internalName/name/vendor), color (RGBA), levels (pan/volume/pitch_shift/filter_mod_x/y/type), enabled, pingPongLoop, locked |
| MixerInsert | index, name, color, icon, output, input, flags (11 named booleans), slots (10 per insert, each with index + pluginName + hasPlugin) |
| Pattern     | id, name, length, color, looped, notes (13-field records), controllers |
| Arrangement | id, name, trackCount, clips, timemarkers (marker or signature kind) |

Plus standalone helpers:
- `buildProjectSummary(project)` — deterministic projection for oracle testing
- `decodeVSTWrapper`, `decodeMixerParams`, `decodeClips`, `decodeNotes`,
  `decodeControllers`, `decodeLevels`, `decodeInsertFlags`,
  `decodeTimeMarkerPosition`, `filterTypeName`, `unpackRGBA`

## Repo layout

```
ts/
├── package.json           # flpdiff-ts, bun + typed-binary
├── tsconfig.json
├── docs/
│   ├── parser-architecture.md   # typed-binary + custom-schemas + error infra
│   └── flp-format-spec.md       # clean-room FLP format spec (living catalog)
├── src/
│   ├── index.ts                 # public exports
│   ├── cli.ts                   # flpdiff-ts CLI
│   ├── summary.ts               # buildProjectSummary (oracle projection)
│   ├── model/
│   │   ├── channel.ts           # Channel, Levels, RGBA, FilterType, ChannelPlugin
│   │   ├── mixer-insert.ts      # MixerInsert, MixerSlot, InsertFlags, MixerParamRecord
│   │   ├── pattern.ts           # Pattern, Note, Controller
│   │   └── arrangement.ts       # Arrangement, Clip, TimeMarker
│   ├── parser/
│   │   ├── errors.ts            # FLPParseError + annotateRead
│   │   ├── primitives.ts        # VarIntSchema, Utf16LeStringSchema, decode helpers
│   │   ├── event.ts             # FLPEventSchema + FL25_OVERRIDES
│   │   ├── flp-project.ts       # parseFLPFile, headline accessors
│   │   ├── vst-wrapper.ts       # decodeVSTWrapper (id-len-val record stream)
│   │   └── project-builder.ts   # buildChannels/buildMixerInserts/buildPatterns/buildArrangements
│   └── diff/
│       └── headline.ts          # pure diffHeadlines + renderHeadlineDiff
├── tools/
│   └── parity/                  # Python ↔ TS parser parity harness
│       ├── py_snapshot.py       # in-process Python snapshot
│       ├── ts-snapshot.ts       # bun-executed TS snapshot
│       ├── run_parity.py        # stratified runner + deep-equal
│       └── classify_versions.py # FL-major stratification helper
└── tests/
    ├── smoke.test.ts            # 5-fixture parametric header+tempo+version
    ├── cli.test.ts              # CLI + pure diff logic
    ├── channels.test.ts         # per-field channel oracle + decoder units
    ├── mixer.test.ts            # inserts + slots + flags + MixerParams raw records
    ├── patterns.test.ts         # pattern name/length/color dedup
    ├── notes.test.ts            # pattern notes + controllers decoders
    ├── arrangements.test.ts     # arrangement count + clips + timemarkers
    └── project-summary.test.ts  # full-structure oracle across all 5 fixtures
```

## Scope by phase

| Phase | What it covers                                     | Status |
|-------|-----------------------------------------------------|--------|
| 3.1   | Scaffold + error infra + format spec                | 4/5 (3.1.4 formal oracle harness remains 🔲 — done informally via test.each) |
| 3.2   | Headline MVP (envelope + version + tempo + PPQ)     | 3/4 ✅ (3.2.2 time signature 🔄 — requires 0xC0 compound-blob decoding) |
| 3.3   | Entity coverage                                     | **6/6 all 🔄 with deep property coverage + 3.3.6 ✅** |
| 3.4   | Port the diff engine from Python                    | 🔲 **deferred pending Roman's confirmation** |
| 3.5   | Browser viewer                                      | 🔲 |
| 3.6   | Go/no-go gate                                       | 🔲 |

## Parity harness (`tools/parity/`)

Two complementary cross-parser checks against Python's
`flp-info --format=json`.

**Pass 1** (counts-and-kinds shape): serialise both parsers'
output of the same file to a compact snapshot (PPQ, tempo, channel
counts by kind, pattern / note / controller totals, insert / slot /
track / clip / marker totals), then deep-compare. Results stratified
by FL major version. **85/85 on Roman's 85-file local corpus.**

```sh
.venv/bin/python ts/tools/parity/run_parity.py tests/corpus/local
```

**Pass 2** (full JSON byte-for-byte): runs Python's installed
`flp-info --format=json` directly and compares against the TS
presentation layer's output (`src/presentation/flp-info.ts` —
`toFlpInfoJson(project)`). 1e-4 float tolerance. Stratified per FL
major + per-field-path drift ranking for prioritisation. **75/85** —
all 9 FL-25, 12 FL-24, 16 FL-21 files pass; 10 FL 9-era edge cases
remain.

```sh
.venv/bin/python ts/tools/parity/run_pass2.py tests/corpus/local
```

Current sweep: **85 / 85** MATCH — every FL version at 100%. The
harness run turned up and we fixed:

| #  | Bug                                                                                             | Impact                                        |
|----|-------------------------------------------------------------------------------------------------|-----------------------------------------------|
| 1  | Playlist opcode `0xD9 → 0xE9` (the reference parser canonical `DATA+25`)                                       | `clips_total=0` on every FL 21+ file         |
| 2  | Orphan-clip filter (`track_rvidx > 499` or missing channel/pattern ref)                          | Clip over-count by ~3× on real files         |
| 3  | Sampler reclassification — `type=Instrument + SamplePath + empty 0xC9 → Sampler` per the reference parser rule  | Channel kinds off by 3–5× on real files      |
| 4  | `hasPlugin` signal on mixer slots (key off 0xD5, not 0xCB)                                      | `filled_slots` undercount by 60–70%          |
| 5  | Legacy tempo fallback (`0x42` coarse + `0x5D` fine)                                             | Every FL 9/11 file showed `tempo: None`      |
| 6  | UTF-16LE 1-byte payloads → "" (FL 9 emits single-null placeholders)                             | 105 "named inserts" on every FL 9 file       |
| 7  | Controllers opcode `0xCF → 0xDF`                                                                | Controllers never fired (3261 missed)        |
| 8  | FL 9 1-slot-per-insert layout (no 0x62 markers → push at 0x93)                                  | `filled_slots=0` on 4 FL 9 files             |
| 9  | Channel scope exits on mixer-section opcodes (`0x93` / `0xCC` / `0xEC`)                         | Phantom plugin names bleeding from mixer     |
| 10 | Stricter reclassification (require 0xC9 event present, not just "plugin undefined")             | Over-flipping on pre-FL-12 layouts           |
| 11 | First-separator swallow in slot `divide` (mirror the reference parser: push on 2nd+ `0x62`, flush at `0x93`)   | `filled_slots` phantom-slot over-count on FL 20-25 |

Per-version match after all eleven fixes:

```
FL 9   14/14  ✅
FL 11   2/2   ✅
FL 12   1/1   ✅
FL 20  32/32  ✅
FL 21  16/16  ✅
FL 24  12/12  ✅
FL 25   8/8   ✅
```

## Known open format work

1. **MixerParams sparse-insert-idx mapping** — `0xE1` records use
   indices like `0, 53, 64..80` that don't map 1:1 to visible insert
   indices 0..17. Raw decoder ships (`decodeMixerParams`); attribution
   to `MixerInsert.slots[].enabled/mix` awaits mapping work.
3. **Muted channel state** — Python reports `muted: false` on every
   channel; source opcode not yet located (possibly inside Levels or a
   flag we haven't decoded).
4. **Channel IsZipped (`0x0F`)** — opcode known from the reference parser, no fixture
   has a zipped channel so no end-to-end path yet.
5. **Note flags bitmask** — each Note carries `flags: number` raw; bit
   positions (Slide = `1<<3`, etc.) not yet decoded as named booleans.
6. **Clip-bearing fixtures** — no committed fixture emits `0xE9`
   playlist clips or `0x94` time-markers; decoders are unit-tested via
   crafted payloads and will activate automatically when a fixture
   exercises them.
7. **Pass 2 parity** — value-level (channel volume, pan, color, insert
   routing, note properties) with unit normalisation between Python's
   normalised-float space and FL's raw integer storage. Pass 1
   (counts-and-kinds shape) is at 85/85 and can be deferred here.

## For the next session

Pass 1 and Pass 2 both landed. Three natural paths:

1. **Start Phase 3.4** (diff engine port). Parser coverage is very
   solid — 85/85 Pass 1, 75/85 Pass 2, 5/5 public oracle. Port
   Python's matcher + comparator + summary formatter from
   `src/flp_diff/{matcher,comparator,summary}.py`. Four sub-phases
   per parent SPEC.
2. **Close the remaining 10 Pass 2 drifts** (all FL 9-era edge
   cases around 0xCB/0xCC attribution). These need a second pass
   post-walk to emulate Python's coarse event-subtree division;
   probably another ~2-3 commits of careful work.
3. **Keep deepening Phase 3.3** — items from the "Known open
   format work" list above (channel muted, IsZipped, note flag
   decoding). Each is ~1 commit of similar shape to recent work.

Roman's been explicit that Phase 3.4 waits for confirmation.
