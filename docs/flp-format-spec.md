# FL Studio Project File Format (`.flp`) — Spec

**Scope:** clean-room specification of the FLP binary format, sufficient to
build an independent reader.
**Provenance:** derived from (a) direct byte inspection of committed FL 25
fixtures in `tests/corpus/re_base/fl25/`, (b) RE-harness byte-sweeps
documented in `fl25-event-format.md`, and (c) observable behavior of the
shipping FL Studio 25.2.4 application via the scripting API. No code was
copied from any GPL FLP library; where existing libraries were consulted
to confirm a *format fact* (opcode number, payload shape), the cross-check
is noted inline. See the clean-room boundary note at the bottom.

**Status:** living document. Updated as the parser grows. Entries are
tagged with confidence:
- **confirmed** — verified by parsing committed fixtures AND matching an
  external oracle (Python `flp-info`, harness sweeps, or Image-Line's
  own display of the value)
- **observed** — the parser handles it without error, but the payload
  semantics are inferred, not verified
- **unknown** — appears in the event stream, no semantic interpretation yet

---

## 1. File envelope

An FLP file is two concatenated chunks: `FLhd` (fixed-size header) and
`FLdt` (variable-length event stream).

### 1.1 `FLhd` header block (14 bytes, **confirmed**)

```
offset  size  field          notes
------  ----  -------------  -----
   0    4     magic          ASCII "FLhd" (0x46 0x4C 0x68 0x64)
   4    4     header_length  uint32 LE, always 6 in practice
   8    2     format         uint16 LE, always 0 on modern FL saves
  10    2     n_channels     uint16 LE, legacy, ignored by modern parsers
  12    2     ppq            uint16 LE, pulses per quarter note
```

`ppq` is the only project-level field exposed directly in the header;
everything else (tempo, time signature, title, etc.) lives in the event
stream.

### 1.2 `FLdt` data block (**confirmed**)

```
offset  size  field     notes
------  ----  --------  -----
  14    4     magic     ASCII "FLdt" (0x46 0x4C 0x64 0x74)
  18    4     data_len  uint32 LE, bytes of event stream that follow
  22    N     events    sequence of TLV events, N == data_len
```

Event-stream parsing stops when the cursor reaches `22 + data_len`.

---

## 2. Event encoding

Every event begins with a single-byte **opcode**. The opcode's numeric
range determines the payload encoding — with FL-25-specific exceptions
catalogued in §2.2.

### 2.1 Opcode-range size rules (default, **confirmed**)

| Opcode range  | Payload kind | Payload encoding          |
|---------------|--------------|---------------------------|
| `0x00`–`0x3F` | BYTE         | 1-byte payload            |
| `0x40`–`0x7F` | WORD         | 2-byte payload (uint16 LE)|
| `0x80`–`0xBF` | DWORD        | 4-byte payload (uint32 LE)|
| `0xC0`–`0xFF` | DATA         | varint length prefix + N bytes |

The varint used for DATA lengths is **LEB128**: each byte contributes 7
payload bits; high bit set means "more bytes follow". 70 encodes as
`0x46`; 212 encodes as `0xD4 0x01`.

### 2.2 FL 25 opcode overrides (**confirmed**)

FL 25 introduced opcodes that violate the range rule. Each override
specifies an alternative payload encoding.

#### `utf16_zterm`

UTF-16LE string terminated by a `00 00` pair at an even byte offset.
**No size prefix**; the byte immediately after the opcode is the low
byte of the first UTF-16 code unit. The captured payload retains the
terminator.

| Opcode | Name           | Status    | Notes |
|--------|----------------|-----------|-------|
| `0x36` | FL version banner | confirmed | Example payload: `"FL Studio 25.2.4.4960.4960\0"`. The 1-byte-payload range-rule fragment of `0x36` in FL 24 and earlier was either unused or differently interpreted; pre-FL-25 files can safely be parsed as if the override applies (they do not emit `0x36` at all). |

#### Pending overrides

`0xC0` carries a *compound blob* — a nested event stream of project
properties (tempo, loop mode, time signature, pan law, title). It
remains varint-prefixed (no size override), but its payload requires a
second-pass decoder. Out of scope for Phase 3.1–3.2; belongs to
Phase 3.3 when compound blobs are decoded.

Additional FL 25 overrides will be added here as discovered.

---

## 3. Opcode catalog

### 3.1 Confirmed opcodes

These have been decoded and oracle-matched against Python's `flp-info`
output on all five FL 25 public fixtures.

| Opcode | Kind | Semantic | Payload layout | Notes |
|--------|------|----------|----------------|-------|
| `0x15` | BYTE (u8) | Channel type | See kind table below | Applies to the channel opened by the most-recent `0x40`. Values: 0=sampler, 2=instrument (the reference parser "Native"), 3=layer, 4=instrument, 5=automation. |
| `0x36` | FL25 override (`utf16_zterm`) | FL version banner | UTF-16LE null-terminated | Full product-edition-and-version label, e.g. `"FL Studio 25.2.4.4960.4960\0"`. See §2.2. |
| `0x40` | WORD (u16 LE) | New channel | Channel iid (uint16) | Announces a new channel. Subsequent channel-scoped events up to the next `0x40` belong to this iid. iids are contiguous `0..n-1` across the project. |
| `0x41` | WORD (u16 LE) | Pattern identity marker | Pattern id (uint16) | Announces the current pattern id. **Fires twice per pattern** (once for note/controller grouping, once for other props) — walkers must dedup by id rather than treating each occurrence as a new pattern. |
| `0x93` | DWORD (u32 LE) | Mixer insert boundary (close) | Ignored | Closes the currently-being-built mixer insert. Unlike `0x40` which *opens* a channel, `0x93` *ends* an insert — events prior to each `0x93` belong to that insert. The count of `0x93` events equals the project's active-insert count (18 on a freshly-saved FL 25 base). |
| `0x9C` | DWORD (u32 LE) | Tempo | `bpm × 1000` | `120000` → 120.0 BPM. Verified via `cycle.py` sweeps at 100/120/130/145/160 BPM (dev repo's `docs/fl25-event-format.md`). |
| `0x9F` | DWORD (u32 LE) | FL build number | uint32 | Value `4960` corresponds to FL Studio 25.2.4 build 4960. |
| `0x62` | WORD (u16 LE) | New mixer effect slot | Slot index (uint16) | Announces a new effect slot within a mixer insert. From the channel walker's perspective, this marks the end of channel-scoped events — subsequent shared-opcode events (e.g., `0xCB` below) belong to the slot's plugin, not to a channel. |
| `0xC1` | DATA (varint + bytes) | Pattern name | Null-terminated UTF-16LE | User-set pattern name (e.g. `"P1"`). Absent for unnamed patterns. Scoped to the pattern id most recently announced by `0x41`. |
| `0xC4` | DATA (varint + bytes) | Channel sample path | Null-terminated UTF-16LE | Full library path for the current channel's sample, e.g. `"%FLStudioFactoryData%/Data/Patches/Packs/Drums/Kicks/909 Kick.wav\0"`. Absent when the channel has no sample loaded (non-sampler kinds, or samplers before a file is dragged in). Scoped to the channel opened by the most-recent `0x40`. |
| `0xC7` | DATA (varint + bytes) | FL version (ASCII) | Null-terminated ASCII | `"25.2.4.4960\0"`, 12 bytes on FL 25.2.4. Duplicated by the UTF-16 banner at `0x36` — the two strings serve different consumers. |
| `0xCB` | DATA (varint + bytes) | Channel/slot name (shared) | Null-terminated UTF-16LE | **Scope-sensitive.** In channel scope (after `0x40`, before any `0x62`) it's the channel name, e.g. `"Sampler"` / `"Kick"` / `"SerumTest"`. In slot scope (after `0x62`) it's the hosted plugin's display name, e.g. `"Fruity Parametric EQ 2"`. Walkers must track the current scope to attribute correctly. |
| `0xCC` | DATA (varint + bytes) | Mixer insert name | Null-terminated UTF-16LE | User-assigned name of the currently-pending insert (the one being accumulated until the next `0x93`). Absent when the user hasn't renamed the insert (master and default inserts are unnamed). Example: `"Drums"` on `base_one_insert.flp`. Distinct opcode from `0xCB`, so no scope ambiguity. |

### 3.2 Observed opcodes (parser handles, semantics unverified)

These appear in the committed fixtures and the parser decodes them
without error, but the semantic interpretation of their payloads is
not yet confirmed by this project's own RE work.

Representative samples from `base_empty.flp` (full histogram in the
parser's debug output):

| Opcode | Kind   | Observed value(s)                         | Notes |
|--------|--------|-------------------------------------------|-------|
| `0x14`–`0x33` | BYTE   | mostly 0 or 1                            | Project-level toggles (loop mode, pan law, etc.). |
| `0x2B` | BYTE   | `0` × 500                                 | Per-track metadata flag; 500 matches FL 25's arrangement track count. |
| `0x45`–`0x68` | WORD   | Various 16-bit values                    | Project-level parameters — to be mapped individually. |
| `0x62` | WORD   | `0` × 180                                 | Per-insert flag. |
| `0x80`–`0xAC` | DWORD  | Various 32-bit values                    | Includes build number (`0x9F`) and others TBD. |
| `0xC0` | DATA   | 212-byte blob                             | Compound project-properties blob (FL 25 format). Inner structure: nested event stream. Decoding planned in Phase 3.3. |
| `0xC7` | DATA   | 12-byte ASCII                             | FL version (above). |
| `0xD5` | DATA   | Variable (354 B for EQ2, up to ~16 KB for Serum) | Plugin state blob. One event per plugin instance. Inner format is plugin-specific. The first 4 bytes of a VST-hosting `0xD5` payload encode an FL-serialization version marker; catalog lives in `fl25-event-format.md`. |
| `0xE1` | DATA   | 6924-byte blob on `base_empty.flp`        | Mixer parameter packing. Layout is sparse on FL 25 (some insert indices empty); full decoding planned in Phase 3.3. |
| `0xEE` | DATA   | 70-byte blob × 500                        | Per-arrangement-track descriptor. |

### 3.3 Unknown opcodes

The parser treats all remaining opcodes as opaque (byte-range rule +
FL25 overrides), carrying their raw payload bytes through as
`Uint8Array`. This is sufficient for round-trip fidelity. Semantic
interpretation grows event-by-event as needs arise.

---

## 4. Version identification

Three different opcodes carry version information; together they pin
down the writing FL version with high confidence:

1. **`0x9F` (confirmed)** — FL build number as `uint32 LE`. For FL 25.2.4
   this is `4960`.
2. **`0xC7` (confirmed)** — ASCII version string, null-terminated.
   `"25.2.4.4960"` on FL 25.2.4.
3. **`0x36` (confirmed, FL25 override)** — UTF-16LE null-terminated
   banner, e.g. `"FL Studio 25.2.4.4960.4960"`.

For tooling that needs a canonical version tag, prefer the ASCII string
at `0xC7` (shortest, stable, parseable). The UTF-16 banner at `0x36`
is human-readable and suitable for display.

Additionally, the first byte of a `0xD5` VST-hosting payload is an
FL-serialization marker correlated with FL version — see
`fl25-event-format.md` for the catalog (FL 9 = 6, FL 20.5 = 9,
FL 21.1 = 10, FL 24.1 = 11, FL 25.2 = 12).

---

## 5. Parsing algorithm (reference)

```
function parse(bytes):
    read magic "FLhd", assert
    read header_length, assert == 6
    read format, n_channels, ppq
    read magic "FLdt", assert
    read data_len
    data_end = cursor + data_len
    events = []
    while cursor < data_end:
        opcode = read uint8
        if opcode in FL25_OVERRIDES:
            payload = read per override rule (e.g. utf16_zterm)
            events.push(blob event)
        elif opcode < 0x40:
            events.push(u8 event with value = read uint8)
        elif opcode < 0x80:
            events.push(u16 event with value = read uint16 LE)
        elif opcode < 0xC0:
            events.push(u32 event with value = read uint32 LE)
        else:
            len = read varint (LEB128)
            payload = read len bytes
            events.push(blob event)
    return { header, events }
```

---

## 6. What this spec does not cover

- **Payload semantics for most events.** The catalog above is a
  starting set, not complete. Most events' internal structure will be
  documented as they are decoded in Phases 3.3 onward.
- **Compound blobs.** `0xC0` and similar compound events contain nested
  event streams. Inner structure is separate from this spec.
- **Plugin state (`0xD5`).** Each plugin's byte layout is effectively
  its own format. Decoders live in per-plugin modules, not here.
- **Automation envelopes (PAHDSR per-sampler).** Parametric, not
  keyframe-based. Out of scope for the top-level event stream.
- **Write path.** This spec focuses on reading. FLP writing is
  non-goal for flpdiff's v0.1 and for Phase 3 broadly.

---

## Clean-room boundary

This specification was written from (a) direct byte inspection of
committed fixtures, (b) `fl25-event-format.md` (itself sourced from
harness sweeps), and (c) running the shipping FL Studio 25.2.4
application.

No code was copied from any GPL FLP library. One cross-check during
development: an existing override table was read to confirm the
encoding rule for opcode `0x36` (`utf16_zterm`, no size prefix)
after two self-derived hypotheses (varint-prefixed, uint16-prefixed)
both looked plausible but failed to align against tempo. That
cross-check was for a **format fact**, not code or structure; the
implementation in this repo is independently written and uses a
different data model, different naming, and a different control flow.

Future additions to this spec should follow the same pattern:
- Observe bytes directly via harness or hex inspection
- Confirm semantics by cross-referencing multiple independent saves
  (value sweeps, same value / different value, different FL versions)
- Cite only format facts, never specific code, class names, or
  data-structure shapes from GPL sources
- If a GPL source is consulted for a format fact, note the cross-check
  inline, as above

---

## Change log

- **2026-04-18** — Initial version. Covers file envelope, 4-bucket
  opcode-range rule, `utf16_zterm` FL 25 override for `0x36`, and
  confirmed opcodes `0x9C` / `0x9F` / `0xC7` / `0x36`. Observed
  opcodes listed for orientation.
- **2026-04-18** (later) — Added `0x40` (new-channel marker) and
  `0x15` (channel type) to the confirmed catalog. Channel-kind
  value table (0/2/3/4/5) documented. Boundary rule captured:
  events between two `0x40`s belong to the first channel.
- **2026-04-18** (later still) — Added `0xC4` (channel sample path,
  UTF-16LE null-terminated in a DATA blob) after oracle parity
  with Python's `flp-info` on the two sample-bearing fixtures.
- **2026-04-18** (evening) — Added `0x62` (slot boundary, slot
  index u16) and `0xCB` (shared channel/slot name, UTF-16LE in
  a DATA blob). First **scope-sensitive** opcode: attribution of
  `0xCB` depends on whether the walker is currently inside a
  channel or a mixer slot. Critical on `base_one_insert.flp`,
  where naïve "first 0xCB per channel" would steal the plugin
  name.
- **2026-04-18** (night) — Added `0x93` (the insert-output event, insert
  close boundary) and `0xCC` (the insert-name event). First Phase 3.3.3
  opcodes. Insert walker counts `0x93` to derive the active-insert
  count (18 on every FL 25 base fixture, matching Python's
  `flp-info`). `0xCC` attribution is unambiguous — separate opcode
  from `0xCB` — so insert names don't need the scope machinery
  that channel/slot names do.
- **2026-04-18** (late night) — Added `0x41` (the pattern-identity event, the
  fires-twice identity marker) and `0xC1` (the pattern-name event). First
  Phase 3.3.2 opcodes. Pattern walker dedups `0x41` by id rather
  than treating each occurrence as a new entity — critical, since
  a single pattern always produces two `0x41` events in the stream.
