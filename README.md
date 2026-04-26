# flpdiff-ts

TypeScript port of [flpdiff](https://github.com/pronskiy/flpdiff).

**Status:** Phase 3.1 (scaffold) ✅, Phase 3.2 (headline MVP) ✅, Phase 3.3
(entities) 🔄 at comprehensive coverage, 3.3.6 (oracle) ✅, 3.3.7 (Pass 1
parity) ✅, 3.3.8 (Pass 2 parity) ✅. **Phase 3.4 (diff engine port) ✅**
— 10 commits across matcher, diff model, comparator (metadata /
channels / patterns / mixer / arrangement / clip-collapse groups),
note diff, automation diff, summary formatter, parity harness.

**Current state:** 308 tests green, 4266 assertions, tsc clean, on
TypeScript 6 + Bun 1.3.9 + typed-binary 4.3.3.

- **5/5 public FL 25 fixtures** — hand-crafted oracle via
  `buildProjectSummary(project)`.
- **85/85 local corpus — Pass 1** (counts-and-kinds shape), every FL
  version 9 through 25 at 100%.
- **83/85 local corpus — Pass 2** (full `flp-info --format=json`
  byte-for-byte with 1e-4 float tolerance) via the TS presentation
  layer at `src/presentation/flp-info.ts`. FL 9-12 at 100%, FL 21-24
  at 100%, 1 FL 20 Kickstart VST wrapper edge case (TS extracts
  FabFilter vendor Python misses — arguably our output is more
  faithful), 1 FL 25 file that crashes Python's `flp-info` (not a
  TS issue).
- **5/6 diff-pairs — Diff parity**: MD5-identical rendered text
  output vs Python's `flpdiff --format text --no-color` on 5 of 6
  real-world diff pairs (dorn-girls / edz_chords / italo_bass_pop /
  j1 / phlegma_dogs). The 6th is the same Kickstart VST vendor
  edge case as above. See `docs/parity-gaps.md`.

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
bun run src/cli.ts path/to/A.flp path/to/B.flp [--verbose]
```

Expected output on a real diff:

```
FLP Diff: v1.flp vs v2.flp
───────────────────────────
Summary: 4 changes (2 channels, 1 mixer, 1 arrangements, 3 tracks)

Channels:
  ~ Channel sampler 'Kick' modified (1 changes)
      ~ Channel volume 78% → 100%
  + Added channel sampler 'New Bass' (sample: ...)

Mixer:
  ~ Insert 8 (unnamed) modified (3 changes)
      + Insert renamed from unset to 'Vocals'
      + Insert color: unset → #5f7581
      ~ Insert volume 100% → 71%

Arrangements:
  ~ Arrangement 'arrangement' modified (0 arrangement changes, 3 track changes)
      ~ Track 'drums' modified (10 changes)
          + 9 clips of 'kick.wav' added (length 4 beats, beats 0 … 32)
```

This output is **MD5-identical** to Python's `flpdiff --format text
--no-color` on real corpus pairs (see `docs/parity-gaps.md` for the
5/6 pass rate and the one documented edge case).

Exit codes: `0` identical, `1` differences found, `2` parse/I/O error.
`--verbose` expands clip-collapse groups back to one line per clip.

Parity harnesses (from the repo root):

```sh
# Pass 1 — counts-and-kinds shape (85/85 on local corpus)
.venv/bin/python ts/tools/parity/run_parity.py tests/corpus/local

# Pass 2 — full flp-info --format=json byte-for-byte (83/85)
.venv/bin/python ts/tools/parity/run_pass2.py tests/corpus/local

# Diff parity — rendered text vs Python's flpdiff CLI (5/6 MATCH)
.venv/bin/python ts/tools/parity/run_diff_parity.py tests/corpus/local
```

## What the parser currently decodes

`parseFLPFile(buffer)` returns an `FLPProject` with:

```ts
{
  header:       { format, n_channels, ppq },
  events:       FLPEvent[],          // raw TLV events (4 kinds)
  metadata:     ProjectMetadata,
  channels:     Channel[],
  inserts:      MixerInsert[],
  patterns:     Pattern[],
  arrangements: Arrangement[],
}
```

Per-entity fields (all optional; populated when the corresponding
opcode is present):

| Entity           | Fields |
|------------------|--------|
| ProjectMetadata  | title, artists, genre, comments, url, dataPath, version (major/minor/patch/build), looped, showInfo, mainPitch, createdOn, timeSpent, timeSignatureNumerator, timeSignatureDenominator, panLaw, mainVolume |
| Channel          | iid, kind, name, sample_path, plugin (internalName/name/vendor), color (RGBA), levels (pan/volume/pitch_shift/filter_mod_x/y/type), enabled, pingPongLoop, locked, zipped, targetInsert, automationPoints |
| MixerInsert      | index, name, color, icon, output, input, pan/volume/stereoSeparation (from MixerParams), flags (11 named booleans), slots |
| FLPProject top-level | insertRouting (project-wide 0xE7 bool stream, paired with MixerParams RouteVolStart records) |
| MixerSlot        | index, pluginName, internalName, pluginVstName, pluginVendor, hasPlugin, enabled, mix |
| Pattern          | id, name, length, color, looped, notes (14-field records incl. raw `flags` + derived `slide`), controllers |
| Arrangement      | id, name, tracks (full Track[] with iid/color/icon/enabled/height/locked/name), clips, timemarkers (marker or signature kind) |

Plus the **presentation layer** at `src/presentation/flp-info.ts` —
`toFlpInfoJson(project)` projects the raw model into Python's
`flp-info --format=json` shape (byte-for-byte with 1e-4 float
tolerance) for cross-parser comparison and for any consumer that
wants Python-compatible output.

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
│   ├── flp-format-spec.md       # clean-room FLP format spec (living catalog)
│   └── flp-info-shape.md        # Pass-2 contract + full closure log
├── src/
│   ├── index.ts                 # public exports (parseFLPFile, toFlpInfoJson, etc.)
│   ├── cli.ts                   # flpdiff-ts CLI
│   ├── summary.ts               # buildProjectSummary (Pass-1 oracle projection)
│   ├── model/
│   │   ├── channel.ts           # Channel, Levels, RGBA, ChannelPlugin, AutomationPoint
│   │   ├── mixer-insert.ts      # MixerInsert, MixerSlot, InsertFlags, MixerParamRecord
│   │   ├── pattern.ts           # Pattern, Note, Controller
│   │   ├── arrangement.ts       # Arrangement, Track, Clip, TimeMarker
│   │   └── metadata.ts          # ProjectMetadata + decodeTimestamp
│   ├── parser/
│   │   ├── errors.ts            # FLPParseError + annotateRead
│   │   ├── primitives.ts        # VarIntSchema, Utf16/Utf8 decoders
│   │   ├── event.ts             # FLPEventSchema + FL25_OVERRIDES
│   │   ├── flp-project.ts       # parseFLPFile + headline accessors
│   │   ├── vst-wrapper.ts       # decodeVSTWrapper (id-len-val record stream)
│   │   └── project-builder.ts   # buildMetadata / buildChannels / buildMixerInserts / buildPatterns / buildArrangements
│   ├── presentation/
│   │   └── flp-info.ts          # toFlpInfoJson — Pass-2 projection to Python flp-info shape
│   └── diff/
│       ├── headline.ts          # pure diffHeadlines + renderHeadlineDiff (Phase 3.2.4 MVP)
│       ├── matcher.ts           # two-pass entity matching (Phase 3.4.1)
│       ├── diff-model.ts        # Change/ChannelDiff/ClipMoveGroup/DiffResult types + factories
│       ├── comparator.ts        # scalar + channel + plugin + pattern diff + orchestrator
│       ├── note-diff.ts         # per-note 3-pass matcher + musical-unit shift renderer
│       ├── automation-diff.ts   # keyframe diff (position-anchored, timeline-ordered)
│       ├── mixer-diff.ts        # compareMixerInsert + compareSlots
│       ├── arrangement-diff.ts  # track diff + 3 clip-collapse group builders
│       └── summary.ts           # renderSummary (byte-identical text renderer vs Python)
├── tools/
│   └── parity/                  # Python ↔ TS parity harnesses (3 passes)
│       ├── py_snapshot.py       # in-process Python Pass-1 snapshot
│       ├── ts-snapshot.ts       # bun-executed TS Pass-1 snapshot
│       ├── run_parity.py        # Pass-1 runner: counts-and-kinds deep-equal
│       ├── ts-flp-info.ts       # bun-executed TS Pass-2 (toFlpInfoJson) emitter
│       ├── run_pass2.py         # Pass-2 runner: full flp-info JSON deep-equal
│       ├── run_diff_parity.py   # Diff parity: renderSummary vs flpdiff CLI (5/6 MATCH)
│       └── classify_versions.py # FL-major stratification helper
└── tests/
    ├── smoke.test.ts            # 5-fixture parametric header+tempo+version
    ├── cli.test.ts              # CLI + pure diff logic
    ├── channels.test.ts         # per-field channel oracle + decoder units
    ├── mixer.test.ts            # inserts + slots + flags + MixerParams raw records
    ├── patterns.test.ts         # pattern name/length/color dedup
    ├── notes.test.ts            # pattern notes + controllers decoders
    ├── arrangements.test.ts     # arrangement count + clips + timemarkers
    ├── metadata.test.ts         # ProjectMetadata u8 fields (time-sig, pan_law, etc.)
    ├── project-summary.test.ts  # full-structure oracle across all 5 fixtures
    ├── matcher.test.ts          # two-pass matching (13 cases vs Python)
    ├── diff-model.test.ts       # validator + default-field coverage (16 cases)
    ├── comparator.test.ts       # scalar comparator + channel/plugin labels
    ├── note-diff.test.ts        # 3-pass note matcher + musical-unit shifts
    ├── automation-diff.test.ts  # keyframe diff + timeline ordering
    ├── mixer-diff.test.ts       # insert + slot + plugin-swap labels
    ├── arrangement-diff.test.ts # track + clip-collapse groups (min-3 threshold)
    └── summary.test.ts          # renderSummary markers + indentation + bucket rules
```

## Scope by phase

| Phase | What it covers                                     | Status |
|-------|-----------------------------------------------------|--------|
| 3.1   | Scaffold + error infra + format spec                | 4/5 (3.1.4 formal oracle harness remains 🔲 — done informally via test.each) |
| 3.2   | Headline MVP (envelope + version + tempo + PPQ)     | 3/4 ✅ (3.2.2 time signature 🔄 — requires 0xC0 compound-blob decoding) |
| 3.3   | Entity coverage                                     | 6/6 🔄 + 3.3.6/3.3.7/3.3.8 ✅ (Pass 1 85/85, Pass 2 83/85) |
| 3.4   | Port the diff engine from Python                    | **✅ 4/4** (matcher, comparator+diff-model, summary formatter, parity harness; 5/6 MATCH on diff_pairs corpus) |
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
major + per-field-path drift ranking for prioritisation. **83/85**
on the local corpus — all FL 9/11/12/21/24 files pass, 7/8 FL 25
(1 PY_ERROR), 31/32 FL 20 (1 wrapper-vendor edge case).

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

**Diff parity** (rendered text, Phase 3.4.4): runs Python's installed
`flpdiff --format text --no-color` and the TS `flpdiff-ts` CLI on
every pair under `tests/corpus/local/diff_pairs/` (auto-discovered
by longest common stem prefix) and MD5-compares the output.

```sh
.venv/bin/python ts/tools/parity/run_diff_parity.py tests/corpus/local
```

**5 / 6 MATCH** on the full diff_pairs corpus — byte-for-byte
identical Python↔TS rendered text:

```
[MATCH] dorn-girls.flp vs dorn-girls_2.flp              md5 f1254ddc
[MATCH] edz_chords_10.flp vs edz_chords_28.flp          md5 36612c73
[DIFF ] h1_86.flp vs h1_86_98.flp                       (Kickstart vendor — known)
[MATCH] italo_bass_pop_15.flp vs italo_bass_pop_18.flp  md5 4517ad63
[MATCH] j1_6.flp vs j1_7.flp                            md5 03d5444a
[MATCH] phlegma_dogs_10.flp vs phlegma_dogs_9.flp       md5 c541fda5
```

Coverage spans FL 20/24/25 projects with real-world content —
vocals, chord progressions, drum chops, multi-bar arrangements —
exercising metadata, channels, patterns, mixer inserts, arrangement
tracks with clip-collapse groups, automation keyframes, and per-note
diff with bucket summarisation. See `docs/parity-gaps.md` for the
single documented DIFF and the stubbed opaque-plugin-state branch.

## Known open format work

1. **Clip-bearing fixtures** — no committed fixture emits `0xE9`
   playlist clips or `0x94` time-markers; decoders are unit-tested via
   crafted payloads and will activate automatically when a fixture
   exercises them.
2. **Zipped-channel end-to-end fixture** — `0x0F` BoolEvent decoder is
   live (`Channel.zipped`), but none of the 85 corpus files has a
   collapsed channel to exercise the "true" branch.
3. **Per-insert routing projection** — the project-level
   `FLPProject.insertRouting` bit-stream is decoded faithfully, but
   pairing each flag with its corresponding MixerParams
   RouteVolStart record (the reference parser's per-insert route iteration semantics) to
   produce a `routes_to: number[]` per insert is deferred. Python's
   `flp-info` emits `routes_to: []` everywhere due to a known
   flp_diff adapter bug, so parity doesn't force this one.

**Closed in prior sessions:**
- Pass 1 parity: **85/85** (counts-and-kinds).
- Pass 2 parity: **83/85** (full `flp-info --format=json` byte-for-byte;
  2 remaining deltas are a Kickstart VST wrapper-vendor case where TS is
  more faithful than Python, and one file where Python's `flp-info`
  crashes). See parity section for detail.
- MixerParams attribution: `0xE1` records unpack via
  `channel_data = (insertIdx << 6) | slotIdx` into
  `MixerInsert.{pan,volume,stereoSeparation}` and
  `MixerSlot.{enabled,mix}`. Presentation layer matches the reference parser's
  `slot.enabled: true` hardcode (a bug in `the MixerParams getter`);
  the real bit is preserved in the internal model.
- Insert routing stream: `FLPProject.insertRouting` holds the
  concatenated `0xE7` bit-stream for future per-insert projection.
- ProjectMetadata u8 fields: `timeSignatureNumerator`,
  `timeSignatureDenominator` (0x11/0x12), `panLaw` (0x17),
  `mainVolume` (0x0C, legacy) — all TS-internal since Python's
  `flp-info` never surfaces them.
- Muted channel state: investigated — the reference parser has no `a channel-muted event`,
  Python's `flp_diff.Channel.muted` defaults to False; TS presentation
  layer matches by construction. `enabled` (IsEnabled `0x00`) is the
  sole audibility signal.
- Note flags bitmask: `Note.slide` now derived from `flags & 0x08`,
  mirroring the reference parser's only catalogued flag. Raw `flags` kept alongside
  for future bit additions and round-trip fidelity.
- Channel zipped: `Channel.zipped` decoded from `0x0F`. Absence ≡ false
  per the reference parser's FL-write-only semantics.

**Closed in Phase 3.4:**
- Diff engine port complete — matcher, diff-model types, scalar
  comparator (metadata/channels/plugin), note diff, automation diff,
  mixer insert diff, arrangement/track/clip-collapse diff, pattern
  diff, DiffResult orchestrator, summary formatter.
- `renderSummary` output **MD5-identical** to Python's `flpdiff
  --format text --no-color` on 5 of 6 real-world corpus diff pairs.
- `flpdiff-ts A.flp B.flp [--verbose]` CLI runs the full semantic
  diff with clip-collapse grouping.

## For the next session

Phase 3.4 is complete. Two realistic paths:

1. **Phase 3.5 (browser viewer)** — bundle the parser + diff engine
   as a static web page. Two file-drop zones + a "Diff" button +
   rendered summary pane. Target <2 MB gzipped. Deployment via
   GitHub Pages / Cloudflare Pages. Sub-phases per parent SPEC:
   3.5.1 minimal UI, 3.5.2 static bundling, 3.5.3 deployment,
   3.5.4 shareable-URL mode (optional).
2. **Keep deepening Phase 3.3** — remaining items in the "Known
   open format work" list above: per-insert routing projection,
   clip-bearing fixtures, zipped-channel fixture. All cosmetic on
   top of the already-solid parity numbers.
3. **Plugin-state registry (Phase 2.1 parallel)** — wire up a TS
   plugin-state decoder registry analogous to Python's
   `flp_diff.plugins`, then route opaque-blob diffs through it so
   `DiffResult.opaqueChanges` starts producing SHA-256 + typed
   per-parameter diffs for known plugins (Fruity EQ 2 first).

Phase 3.6 go/no-go gate follows whichever of these you pick.
