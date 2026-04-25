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
| `0x00` | BYTE (u8) | Channel IsEnabled | bool | Emitted on every channel in FL 25 saves; defaults true. |
| `0x14` | BYTE (u8) | Channel PingPongLoop | bool | Default false; opcode emitted on every channel. |
| `0x15` | BYTE (u8) | Channel type | See kind table below | Applies to the channel opened by the most-recent `0x40`. Values: 0=sampler, 2=instrument (FL labels this "Native"), 3=layer, 4=instrument, 5=automation. |
| `0x36` | FL25 override (`utf16_zterm`) | FL version banner | UTF-16LE null-terminated | Full product-edition-and-version label, e.g. `"FL Studio 25.2.4.4960.4960\0"`. See §2.2. |
| `0x40` | WORD (u16 LE) | New channel | Channel iid (uint16) | Announces a new channel. Subsequent channel-scoped events up to the next `0x40` belong to this iid. iids are contiguous `0..n-1` across the project. |
| `0x41` | WORD (u16 LE) | Pattern identity marker | Pattern id (uint16) | Announces the current pattern id. **Fires twice per pattern** (once for note/controller grouping, once for other props) — walkers must dedup by id rather than treating each occurrence as a new pattern. |
| `0x20` | BYTE (u8) | Channel IsLocked | bool | FL 12.3+. Default false; opcode emitted on every channel. |
| `0x21` | BYTE (u8) | TimeMarker numerator | uint8 | Only meaningful for `signature`-kind markers (part of a time-signature change). |
| `0x22` | BYTE (u8) | TimeMarker denominator | uint8 | Same as 0x21 — only for signature markers. |
| `0x5F` | WORD (u16 LE) | Insert icon id | int16 | FL only emits when the user has explicitly set a custom icon; default inserts omit this entirely. |
| `0x94` | DWORD (u32 LE) | TimeMarker position | uint32 (high bit 0x08000000 = signature kind) | Opens a new time-marker entity. Low 27 bits = tick position; bit 27 set = `signature` kind (carries numerator/denominator), otherwise `marker` kind (plain text marker). |
| `0x93` | DWORD (u32 LE) | Mixer insert output routing + boundary (close) | int32 target index | Dual role: **closes** the currently-being-built insert (walker boundary) AND carries the insert's output-routing target as value. Two default sentinels in the wild: `-1` (0xFFFFFFFF, "no explicit route, defaults to master") and `value === insert.index` (master routing to itself). Both are "default" and should suppress to undefined in downstream summaries; other values are user-set overrides. |
| `0x95` | DWORD (u32 LE) | Insert color | RGBA packed LE | Same byte packing as `0x80`. Absent unless user set a color on this insert. |
| `0x9A` | DWORD (u32 LE) | Insert audio input source | int32 | Same `-1` default-sentinel semantics as `0x93`. |
| `0x80` | DWORD (u32 LE) | Plugin/channel color | RGBA packed LE | Low byte is R, then G, B, A — reading as uint32 LE and extracting bytes via `value & 0xFF`, `(value >> 8) & 0xFF`, etc. FL's default channel color is `0x00484541` → `{r: 65, g: 69, b: 72, a: 0}`. Shared between channels and mixer-slot plugins; scope gating (channel vs slot) keeps attribution clean. |
| `0x96` | DWORD (u32 LE) | Pattern color | RGBA packed LE | the pattern-color event. Same byte packing as `0x80`. Only emitted when the user has touched the pattern's color — otherwise absent. |
| `0x1A` | BYTE (u8) | Pattern looped flag | bool (0/1) | the pattern-looped event. FL only emits this opcode when the pattern is actually looped; an unlooped pattern gets no event and consumers must default to `false`. |
| `0xA4` | DWORD (u32 LE) | Pattern length | PPQ ticks | the pattern-length event. Value `0` means "use the project's default bar length" — FL omits an explicit length for unmodified patterns; Python flp-info also reports `0` in that case. |
| `0x9C` | DWORD (u32 LE) | Tempo | `bpm × 1000` | `120000` → 120.0 BPM. Verified via `cycle.py` sweeps at 100/120/130/145/160 BPM (dev repo's `docs/fl25-event-format.md`). |
| `0x9F` | DWORD (u32 LE) | FL build number | uint32 | Value `4960` corresponds to FL Studio 25.2.4 build 4960. |
| `0x62` | WORD (u16 LE) | Mixer effect slot boundary (close) | Slot index (uint16) | **Closes** the current slot's accumulation — events for slot K (plugin name, wrapper, state) fire BEFORE the `0x62` that carries value K. Always emitted in groups of 10 per insert (slots 0..9), even for empty slots. For the channel walker, any `0x62` marks the end of channel-scoped events and the start of mixer section. |
| `0x63` | WORD (u16 LE) | Arrangement identity marker | Arrangement id (uint16) | Announces a new playlist arrangement. FL 25 base projects have exactly one with id=0. Subsequent arrangement-scoped events (name, track descriptors) belong to the most-recently-announced arrangement. |
| `0xC1` | DATA (varint + bytes) | Pattern name | Null-terminated UTF-16LE | User-set pattern name (e.g. `"P1"`). Absent for unnamed patterns. Scoped to the pattern id most recently announced by `0x41`. |
| `0xC9` | DATA (varint + bytes) | Plugin internal class name | Null-terminated UTF-16LE | FL's identifier for the plugin's wrapper class. For native plugins (e.g. mixer-slot Fruity EQ 2) this matches the display name. For VST-wrapped channel-hosted plugins the payload is `"Fruity Wrapper"` (generic FL VST host); the real VST name (`"Serum"`, etc.) lives inside the `0xD5` plugin-state blob — see below. Sampler channels emit an empty `0xC9` as a placeholder — walkers should treat zero-length payloads as "no plugin". |
| `0xE9` | DATA (varint + bytes) | Arrangement playlist clips | Dense array of 60-byte records (FL 21+) or 32-byte records (earlier) | **Simply absent when the arrangement has no clips** — the empty-playlist case produces no event rather than a zero-record blob. Each FL 21+ record: `uint32 position`, `uint16 pattern_base` (always 20480), `uint16 item_index`, `uint32 length`, `uint16 track_rvidx` (stored reversed), `uint16 group`, 2 reserved bytes, `uint16 item_flags`, 4 reserved bytes, `float32 start_offset`, `float32 end_offset`, 28 trailing reserved bytes. TS parser previously had `0xD9` hard-coded (wrong); the parity harness on `tests/corpus/local/` surfaced it. |
| `0xDB` | DATA (varint + bytes) | Channel Levels struct | 24-byte fixed record | One per channel on FL 25 (pre-FL-25 saves emit Levels at `0xCB`, but `0xCB` is taken by Name; FL 25 relocates Levels to `0xDB`). Fields: `int32 pan`, `uint32 volume`, `int32 pitch_shift`, `uint32 filter_mod_x`, `uint32 filter_mod_y`, `uint32 filter_type`. Default values `{pan: 6400, volume: 10000, pitch_shift: 0, filter_mod_x: 256, filter_mod_y: 0, filter_type: 0}` — Python's `flp-info` exposes these as normalized floats `volume/12800 = 0.78125` and `pan/6400 = 1.0`. |
| `0xD5` | DATA (varint + bytes) | Plugin state blob | Plugin-specific binary | For **VST-wrapped** plugins (internalName `"Fruity Wrapper"`) the payload is the FL VST-wrapper record stream: 4-byte `type` header (first byte = FL serialization marker, one of 6/8/9/10/11/12), then repeating `{uint32 id, uint64 len, N bytes data}` records. Relevant record ids: 54=Name (UTF-8), 56=Vendor (UTF-8), 55=PluginPath, 51=FourCC, 52=GUID, 53=State (opaque preset data). For **native** FL plugins (e.g. Fruity Parametric EQ 2) the payload is plugin-specific state — the VST-wrapper record format does not apply; decode per-plugin. |
| `0xE0` | DATA (varint + bytes) | Pattern notes (FL 25) | Dense array of 24-byte records | FL 25 emits pattern notes at `0xE0`; pre-FL-25 saves emit them at `0xD0` (another FL 25 +16 relocation, also seen with track data). Each record: `uint32 position`, `uint16 flags`, `uint16 rack_channel`, `uint32 length`, `uint16 key`, `uint16 group`, `uint8 fine_pitch`, `uint8 _reserved`, `uint8 release`, `uint8 midi_channel`, `uint8 pan`, `uint8 velocity`, `uint8 mod_x`, `uint8 mod_y`. All lengths in PPQ ticks. |
| `0xC4` | DATA (varint + bytes) | Channel sample path | Null-terminated UTF-16LE | Full library path for the current channel's sample, e.g. `"%FLStudioFactoryData%/Data/Patches/Packs/Drums/Kicks/909 Kick.wav\0"`. Absent when the channel has no sample loaded (non-sampler kinds, or samplers before a file is dragged in). Scoped to the channel opened by the most-recent `0x40`. |
| `0xC7` | DATA (varint + bytes) | FL version (ASCII) | Null-terminated ASCII | `"25.2.4.4960\0"`, 12 bytes on FL 25.2.4. Duplicated by the UTF-16 banner at `0x36` — the two strings serve different consumers. |
| `0xCB` | DATA (varint + bytes) | Channel/slot name (shared) | Null-terminated UTF-16LE | **Scope-sensitive.** In channel scope (after `0x40`, before any `0x62`) it's the channel name, e.g. `"Sampler"` / `"Kick"` / `"SerumTest"`. In slot scope (after `0x62`) it's the hosted plugin's display name, e.g. `"Fruity Parametric EQ 2"`. Walkers must track the current scope to attribute correctly. |
| `0xCD` | DATA (varint + bytes) | TimeMarker name | Null-terminated UTF-16LE | User-set marker label. Scoped to the most-recently-announced time-marker (via `0x94`). |
| `0xCF` | DATA (varint + bytes) | **Overloaded**: the pattern-controllers event OR the project-artists event | 12-byte records (controllers) OR UTF-16LE string (artists) | the reference parser lists both at `DATA+15 = 0xCF`. In practice FL emits one or the other depending on context: non-empty multi-record blobs are pattern controllers (12-byte records: `uint32 position`, 2 reserved, `uint8 channel`, `uint8 flags`, `float32 value`); tiny payloads are the Artists UTF-16LE string. Walker size-gates on `payload.byteLength % 12 === 0 && length > 0` to route correctly. |
| `0xCC` | DATA (varint + bytes) | Mixer insert name | Null-terminated UTF-16LE | User-assigned name of the currently-pending insert (the one being accumulated until the next `0x93`). Absent when the user hasn't renamed the insert (master and default inserts are unnamed). Example: `"Drums"` on `base_one_insert.flp`. Distinct opcode from `0xCB`, so no scope ambiguity. |
| `0xE1` | DATA (varint + bytes) | MixerParams sparse blob | Dense array of 12-byte records | the MixerParams event. One large blob per project (6924 B = 577 records on `base_empty.flp`). Each record: `4 reserved + uint8 id + uint8 reserved + uint16 channel_data + int32 msg`. `insertIdx = (channel_data >> 6) & 0x7F`, `slotIdx = channel_data & 0x3F`. IDs: `0=SlotEnabled, 1=SlotMix, 64..191=RouteVol, 192=Volume, 193=Pan, 194=StereoSeparation, 208..210=EQ gains, 216..218=EQ freqs, 224..226=EQ Qs`. **FL 25's `insertIdx` packing is sparse** — records exist for indices well outside the visible 0..17 range (e.g. 53, 64..80). Mapping sparse indices to visible inserts remains open; decoder exposed as raw records via `decodeMixerParams`. |
| `0xEC` | DATA (varint + bytes) | Insert flags bitmask (FL 25 relocation) | 12-byte fixed record | **the reference parser lists `the insert-flags event = DATA+28 = 0xDC`, but FL 25 emits at `DATA+44 = 0xEC`** — fourth self-discovered FL 25 relocation (joining 0xEE track data, 0xE0 pattern notes, 0xDB channel Levels). Payload: 4 reserved + `uint32 flags` (at offset 4) + 4 reserved. Bit positions: `0=PolarityReversed, 1=SwapLeftRight, 2=EnableEffects, 3=Enabled, 4=DisableThreadedProcessing, 6=DockMiddle, 7=DockRight, 10=SeparatorShown, 11=Locked, 12=Solo, 15=AudioTrack`. Master + insert 17 default to `0x0C` (EnableEffects+Enabled); inserts 1..16 default to `0x4C` (+DockMiddle). |
| `0xEE` | DATA (varint + bytes) | Per-track data blob | 70-byte binary blob | Descriptor for one playlist track within the current arrangement. FL 25 emits these in large fixed batches (500 per arrangement on a base project) regardless of whether the tracks carry clips. Count equals the arrangement's track count. Inner structure is TBD — carried as an opaque `Uint8Array` by the skeleton parser. |
| `0xF1` | DATA (varint + bytes) | Arrangement name | Null-terminated UTF-16LE | User-assigned or default name (`"Arrangement"` on fresh FL 25 saves). Scoped to the arrangement most recently announced by `0x63`. |

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
- **2026-04-18** (night) — Added `0x93` (insert close boundary +
  output routing) and `0xCC` (insert name). Insert walker counts
  `0x93` to derive the active-insert count (18 on every FL 25
  base fixture, matching Python's `flp-info`). `0xCC` attribution
  is unambiguous — separate opcode from `0xCB` — so insert names
  don't need the scope machinery that channel/slot names do.
- **2026-04-18** (late night) — Added `0x41` (pattern identity
  marker, fires twice per pattern) and `0xC1` (pattern name).
  Pattern walker dedups `0x41` by id rather than treating each
  occurrence as a new entity — critical, since a single pattern
  always produces two `0x41` events in the stream.
- **2026-04-18** (even later) — Added `0x63` (arrangement identity
  marker, uint16 id), `0xF1` (arrangement name), and `0xEE`
  (per-track data blob). Arrangement walker counts `0xEE` events
  within each arrangement's scope to derive the track count (500
  on every FL 25 base fixture, matching Python's `flp-info`).
  Note: `0xEE` is where FL 25 carries per-track data; older FL
  versions used `0xDE`, which does not appear in FL 25 saves.
- **2026-04-19** — Phase 3.3.5 mixer-slot plugin metadata. Revised
  the `0x62` semantics: it's a slot CLOSER, not an opener. Plugin
  events (0xCB display name, 0xD5 state, etc.) fire BEFORE the
  `0x62` that carries that slot's index. FL emits 10 × `0x62` per
  insert (slots 0..9), even for empty slots. Mixer walker now
  accumulates a `pendingSlot` and pushes it to the insert's
  slots[] on each `0x62`, using the `0x62` value as the slot index.
- **2026-04-20** — Added insert-level opcodes beyond Name:
  `0x95` (color, RGBA uint32), `0x5F` (icon id, int16), `0x9A`
  (audio input, int32 with `-1` sentinel), and routing via the
  existing `0x93` event's value (also int32 with `-1` or
  "self-index" sentinels). None fire with non-default values on
  the 5 current fixtures — all handlers are in place and
  regression-tested, activating automatically on future fixtures
  that exercise mixer routing.
- **2026-04-19** (end of day) — Added `0xDB` channel Levels
  decoder. One 24-byte blob per channel with `int32 pan`,
  `uint32 volume`, `int32 pitch_shift`, `uint32 filter_mod_x/y`,
  `uint32 filter_type`. Raw integer storage (no float
  normalization) — callers divide by 12800 for volume or 6400 for
  pan to match Python flp-info's normalization. All 5 current
  fixtures have identical default Levels (pan 6400, volume 10000,
  etc.) on every channel.
- **2026-04-19** (even later still) — Added `0xE9` arrangement
  playlist clip decoder. Dense array of 60-byte records on FL 21+
  (with a 32-byte fallback for older saves). All 5 current
  fixtures have 0 clips and don't emit `0xE9` at all — the walker
  handles this natively (absence = empty playlist). Decoder is
  unit-tested via crafted payload; awaits a clip-bearing fixture
  for end-to-end oracle. **Correction (same day, via parity
  harness):** initial commit used `0xD9` by mistake. The 5 public
  fixtures have no clips so the oracle didn't catch it; the first
  real-corpus run found every local FL 21+ file reporting
  `clips_total=0`. Fix: single-byte constant change in
  `project-builder.ts`.
- **2026-04-19** (later still) — Added `0xE0` pattern notes
  decoder. First musical-content primitive the parser decodes.
  24-byte fixed-record stream; each record is a full Note
  (position, key, length, velocity, channel-iid, fine-pitch,
  pan, release, mod-x/y). **Second FL 25 opcode relocation
  observed**: pre-FL-25 saves emit notes at `0xD0`, FL 25 at
  `0xE0`. Validated against Python `flp-info` on
  `base_one_pattern.flp` — the single 909-Kick note decodes
  exactly.
- **2026-04-19** (later) — Added `0x80` (channel/plugin color,
  uint32 LE). RGBA bytes in LE order `[R, G, B, A]`. FL defaults
  freshly-created sampler channels to `0x00484541` (gray).
  `base_one_channel`'s second channel gets `0x006a655c` (a lighter
  shade). Channel walker attributes 0x80 only in channel scope so
  the same opcode in mixer-slot scope doesn't bleed across.
- **2026-04-19** (late) — Added `0xD5` VST-wrapper decoding. When
  the hosting entity's `internalName === "Fruity Wrapper"`, the
  0xD5 payload is parsed as a record stream to extract the VST
  display name (id=54), vendor (id=56), path (id=55), and FourCC
  (id=51). `base_one_serum.flp` now surfaces
  `channels[1].plugin.name === "Serum"` and `vendor === "Xfer Records"`
  instead of just the generic wrapper label. Native-plugin `0xD5`
  payloads (e.g. Fruity EQ 2) are left opaque — the record-stream
  shape does not apply to them.
