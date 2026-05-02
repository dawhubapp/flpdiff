# FL Studio 25 — Event Format Findings

How FL Studio 25's FLP event stream differs from earlier-version
saves. Tested against **FL Studio 25.2.4 Producer Edition
[build 4960]** on macOS.

## TL;DR

FL 25 introduced new event opcodes that **do not follow the standard
opcode-range sizing rules** (BYTE 0–63 → 1B payload, WORD 64–127 →
2B, DWORD 128–191 → 4B, TEXT/DATA 192–255 → varint-prefixed). At
least one opcode in the DWORD range (`0xAC`) carries a 3-byte
payload, not 4. Without correct event partitioning, downstream
parsing fails — the 0xAC misparse swallows the next event's opcode
byte, corrupting the rest of the stream.

This doc catalogs the FL 25 deviations and how the TS parser handles
them via its override table.

## The empirical finding — tempo

Tempo is at **file byte offset 155, as `bpm × 1000` uint32 LE** on a
minimal-project shape (empty title, empty comments, one channel).

```
Verified by running the Python-side RE harness at multiple BPM values:

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
Once `0xAC`'s 3-byte sizing is handled correctly the unified `0x9C`
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

This works for FL 12-24. For FL 25, `0xAC` violates the range
convention. Catalogue so far (from inspecting `base_empty.flp`):

### `0xAC` — 3-byte payload (DWORD-range violation)

**Range rule says**: DWORD, 4-byte payload.
**Actually**: 3-byte payload, no size prefix.

Evidence (event stream from `base_empty.flp`, FL 25.2.4 build 4960):

```
byte 48: ac           (opcode)
bytes 49-51: 01 01 00 (3-byte payload, semantic content TBD)
byte 52: c0           (next opcode — TEXT range, version banner)
byte 53: 36           (varint length = 54)
bytes 54-107: UTF-16-LE "FL Studio 25.2.4.4960.4960\0"
              — 54 bytes = 27 UTF-16 code units
```

Naïve 4-byte parsing of `0xAC` consumes byte 52 (`0xC0`) as part of
the payload, then reads byte 53 (`0x36`) as the next opcode. `0x36`
in the BYTE range nominally takes a 1-byte payload — which would
fragment the version banner into ~27 fake BYTE events. The TS
parser previously hid this by overriding `0x36` as a
`utf16_zterm` opcode (read until `00 00`); both interpretations
consume the same byte range but the event identity was wrong. See
issue #1 for the discovery.

The TS parser now treats `0xAC` as a 3-byte blob (override table
in `src/parser/event.ts`). The version banner falls out as a normal
`0xC0` TEXT event with varint-prefixed UTF-16-LE payload — no
override needed.

### `0xC0` — historical note

`0xC0` (TEXT range, VarInt size + payload) was reused for per-channel
UTF-16 names through FL 24. In FL 25 minimal saves the first `0xC0`
event is the project's UTF-16 version banner; PyFLP additionally
documents larger `0xC0` payloads on FL 25 saves as an opaque
project-properties blob. `getFLVersionBanner` disambiguates by
requiring the decoded UTF-16 string to start with "FL Studio".

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

A Python-side RE harness drives FL Studio via the MIDI scripting API
to produce sweep fixtures (lives in the dev-side `python/tools/re_harness/`,
not part of this TS package). Method:

1. Start from a known-state base FLP (e.g., `base_empty.flp`).
2. Run a "sweep": modify one field to multiple known values
   (tempo 100, 130, 160; or time sig 3/4, 4/4, 5/4; or title
   "a", "ab", "abc").
3. Byte-diff the resulting files. Bytes that change monotonically
   with the field are its encoding. The *enclosing event* is
   whatever event starts at a nearby offset and whose size is
   consistent across all sweep values.
4. When a candidate event's opcode + nominal size rule would
   underrun or overrun a reasonable payload (e.g., `0xAC` in DWORD
   range whose "4th byte" is always the next event's opcode),
   you've found a range-rule violation.

Keep a catalog: `opcode → actual size rule → semantic field`.
Add new entries to the override table in `src/parser/event.ts`.

## Methodology reminder — reproducibility

The tempo-sweep artifacts that backed this doc were generated via
the Python-side RE harness driving FL Studio's MIDI scripting API
(set tempo → save → snapshot, repeat at known values). They aren't
committed — regenerate locally as needed.

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
  violations (later corrected — see 2026-05-02).
- **2026-05-02** — Issue #1 (Holzchopf) corrected the FL 25 banner
  classification: `0x36` is NOT an opcode; it's the varint length
  byte of a `0xC0` TEXT-range event. The real range-rule violation
  is `0xAC`, which carries a 3-byte (not 4-byte) payload. Override
  table now: `{0xAC: byte3}`; `0x36` removed.
- **2026-04-17** — Tempo end-to-end via the existing `0x9C` opcode
  once the FL 25 overrides realign the event stream. `0xE1`
  MixerParams sparse-packing documented.
- **2026-04-18** — VST plugin-state FL-serialization marker
  catalogued (FL 9 = 6, FL 20.5 = 9, FL 21.1 = 10, FL 24.1 = 11,
  FL 25.2 = 12). EQ 2 plugin-state RE captured.
