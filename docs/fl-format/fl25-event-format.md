# FL Studio 25 — Event Format Findings

How FL Studio 25's FLP event stream differs from earlier-version
saves. Tested against **FL Studio 25.2.4 Producer Edition
[build 4960]** on macOS.

## TL;DR

FL 25 introduced new event opcodes that **do not follow the standard
opcode-range sizing rules** (BYTE 0–63 → 1B payload, WORD 64–127 →
2B, DWORD 128–191 → 4B, TEXT/DATA 192–255 → varint-prefixed).
Several opcodes in the BYTE range (`0x36`) and DWORD range (`0xC0`)
carry variable-length payloads in FL 25. Without correct event
partitioning, downstream parsing fails — events get fragmented into
many bogus small ones, corrupting everything that follows.

This doc catalogs the FL 25 deviations and how the TS parser handles
them via its override table.

## The empirical finding — tempo

Tempo is at **file byte offset 155, as `bpm × 1000` uint32 LE** on a
minimal-project shape (empty title, empty comments, one channel).

```
Verified by running tools/re_harness/cycle.py at multiple BPM values:

  tempo=100  bytes[155:159] = a0 86 01 00   u32 LE = 100000   (100 × 1000) ✓
  tempo=120  bytes[155:159] = c0 d4 01 00   u32 LE = 120000   (120 × 1000) ✓
  tempo=130  bytes[155:159] = d0 fb 01 00   u32 LE = 130000   (130 × 1000) ✓
  tempo=145  bytes[155:159] = 68 36 02 00   u32 LE = 145000   (145 × 1000) ✓
  tempo=160  bytes[155:159] = 00 71 02 00   u32 LE = 160000   (160 × 1000) ✓
```

**Important caveat**: byte 155 is only the *correct* offset for this
specific minimal-project shape. Larger projects with content before
the tempo field will push the offset around. Tempo's position is
**inside some event's payload**, not a file-header field. Finding
that enclosing event requires correctly parsing the event stream.
Once `0x36` and `0xC0` are handled correctly the unified `0x9C`
tempo event surfaces as a normal DWORD event and `tempo / 1000`
gives the right BPM.

## The real problem — event range rules are wrong on FL 25

Standard event categorisation:

```
0-63     BYTE    → 1-byte payload
64-127   WORD    → 2-byte payload
128-191  DWORD   → 4-byte payload
192-255  TEXT/DATA → VarInt size prefix + payload
```

This works for FL 12-24. For FL 25, at least two opcodes violate the
range convention. Catalogue so far (from inspecting `base_empty.flp`):

### `0x36` — variable-length UTF-16 string (FL major version string)

**Range rule says**: BYTE, 1-byte payload.
**Actually**: carries a ~70-byte UTF-16-LE string (`"FL Studio
Producer Edition v25.2.4\0"`) prefixed with a 1-byte size.

Evidence: bytes 53-124 in any normalized FL 25 save decode as:

```
byte 53: 0x36       (opcode)
byte 54: 0x46       (= 70, the payload size in bytes)
bytes 55-124: UTF-16-LE "L Studio Producer Edition v25.2.4\0"
             — 70 bytes = 35 UTF-16 code units
```

Naïve range-rule parsing reads byte 53 as "opcode 0x36 with 1-byte
payload = 0x46", then byte 55 as "opcode 0x00 with 1-byte payload =
0x4c" (the 'L'), and so on — fragmenting the one string into 35
fake "BYTE events" each carrying one character.

Note the 'F' of "FL Studio" lives in byte 54 (the size byte,
decimally 70, hex `0x46` — ASCII 'F'; a confusing coincidence).

The TS parser handles this via the `utf16_zterm` override (see
`flp-format-spec.md` §2.2).

### `0xC0` — compound project-properties blob

**Range rule says**: TEXT/DATA, VarInt size prefix (size decodes
correctly as 212 bytes).
**Problem**: an FL-25-aware parser must NOT decode the 212-byte
payload as a UTF-16 string — it isn't text, it's a nested event
stream of project properties (tempo, loop mode, time signature,
pan law, etc.).

The TS parser treats `0xC0` as an opaque blob; inner-stream
decoding is deferred until a use case lands.

## Why this matters for flpdiff

Without correct event partitioning, we can't:

- Map tempo, time signature, pan law, title, etc. to their real
  opcodes.
- Tell users "tempo changed from 120 to 145 BPM" in diff output.
- Match channels, patterns, inserts by stable identity — every
  downstream piece of the canonical model assumes events have been
  correctly walked.

With correct partitioning, all of the above becomes mostly a
mapping exercise once we know which opcodes carry which fields.

## How to discover more FL 25 opcodes

The harness in `tools/re_harness/` is the right tool. Method:

1. Start from a known-state base FLP (e.g., `base_empty.flp`).
2. Run a "sweep" via `tools.re_harness.cycle`: modify one field to
   multiple known values (tempo 100, 130, 160; or time sig 3/4,
   4/4, 5/4; or title "a", "ab", "abc").
3. Byte-diff the resulting files. Bytes that change monotonically
   with the field are its encoding. The *enclosing event* is
   whatever event starts at a nearby offset and whose size is
   consistent across all sweep values.
4. When a candidate event's opcode + nominal size rule would
   underrun or overrun a reasonable payload (e.g., `0x36` in BYTE
   range trying to hold 70 bytes), you've found a range-rule
   violation.

Keep a catalog: `opcode → actual size rule → semantic field`.
Add new entries to the override table in `src/parser/event.ts`.

## Methodology reminder — reproducibility

The tempo-sweep artifacts that backed this doc were generated by:

```bash
python -m tools.re_harness.cycle \
    --base tests/corpus/re_base/fl25/base_empty.flp \
    --set-tempo 100.0 --auto
cp tests/corpus/re_base/scratch/base_empty.flp /tmp/tempo_sweep/tempo_100.flp
# repeat for 130 and 160
```

These aren't committed (they live in `/tmp/tempo_sweep/`) —
regenerate locally as needed. Future sweeps for other fields follow
the same shape.

## VST plugin-state payload — FL serialization marker

When `0xD5` (plugin state) carries a VST (not a native FL plugin)
the payload begins with a 4-byte little-endian `type` field. Its
first byte is an FL-serialization marker that tracks the **FL Studio
version that wrote the file**, not the plugin vendor. The identical
Ozone 10 (iZotope, VST3) instance appears as marker 10 in an FL
21.1 save and marker 11 in an FL 24.1 save. Best hypothesis: FL
bumps the byte whenever it changes the surrounding event's
serialization format between releases.

Mapping observed so far:

| FL version | Marker | Source |
|---|---|---|
| 9     | 6  | `4frontpiano.flp`, `TheCastle_19.flp`, `ambience.flp` |
| 12–20 | 8, 10 | older corpus |
| 20.5  | 9  | `phlegma_dogs_9.flp` (Sylenth1) |
| 21.1  | 10 | `salut-vera_4.flp` (Ozone 10 etc.) |
| 24.1  | 11 | `dorn-girls.flp` (Ozone 10, soothe2) |
| 25.2  | 12 | `base_one_serum.flp` (Serum) |

The byte is stored as `type` and never used to branch — payloads
parse identically regardless. New FL releases simply add new
markers to the allowlist.

## `0xE1` MixerParams sparse packing on FL 25

Opcode `0xE1` (MixerParams blob) still appears in FL 25 saves and
still packs per-channel / per-slot mixer parameters in its payload
— but the `channel_data` bit-packing produces a much sparser index
than FL 24 did. On a minimal FL 25 save (`base_empty.flp`), the
populated insert indices are `{0, 53, 64, 65, ..., 80}` — master,
one scratch index, then 17 default inserts — whereas the mixer
walks 127 insert positions overall.

The TS parser handles this by silently dropping records whose
`insertIdx` falls outside the visible-insert range (they target
slots FL allocated but didn't surface via `0x93`). See
`buildMixerInserts` in `src/parser/project-builder.ts`.

## `0xD5` plugin state — Fruity Parametric EQ 2 RE

Opcode `0xD5` is the per-slot plugin-state blob, one event per
plugin instance. Content is plugin-specific.

Reverse-engineered Fruity Parametric EQ 2 (FL's native 7-band
parametric EQ) via the `plugins.setParamValue` harness handler + a
per-parameter save/diff sweep. Blob is 354 bytes on FL 25.2.4;
layout is uniform 4-byte slots with a 4-byte header and 144 bytes
of trailing un-decoded state. 36 parameters across 7 bands + main
level. Scale factor: normalized param value `v` stores as
`round(v * 0xFFFF)` for uint16 fields.

Serum's VST state blob occupies `0xD5` too, but its payload size
drifts across same-value saves (session-internal state) — so the
fixed-offset RE approach that worked for EQ 2 doesn't translate.
Full VST chunk decoding or differential-noise RE is needed;
deferred.

## Changelog

- **2026-04-16** — Initial version. Tempo at bytes 155-158 as
  `bpm × 1000` u32 LE. Documented `0x36` and `0xC0` range-rule
  violations.
- **2026-04-17** — Tempo end-to-end via the existing `0x9C` opcode
  once the FL 25 overrides realign the event stream. `0xE1`
  MixerParams sparse-packing documented.
- **2026-04-18** — VST plugin-state FL-serialization marker
  catalogued (FL 9 = 6, FL 20.5 = 9, FL 21.1 = 10, FL 24.1 = 11,
  FL 25.2 = 12). EQ 2 plugin-state RE captured.
