# `flp-info --format=json` output shape (Python etalon)

This is the contract the TS **presentation layer** (`src/presentation/flp-info.ts`)
has to reproduce byte-for-byte. Derived by dumping
`.venv/bin/flp-info --format=json` across the five committed FL 25 fixtures
and cross-checking each field.

Scope note: `_type` tags are **required** — they're what Python's encoder
emits to signal nested types. Runner deep-compares the whole blob with
numeric tolerance (`1e-4`) for float fields.

## Top-level

```jsonc
{
  "_type": "FLPProject",
  "metadata":     ProjectMetadata,
  "channels":     Channel[],
  "patterns":     Pattern[],
  "mixer":        Mixer,
  "arrangements": Arrangement[],
  "opaque_events": OpaqueEvent[],   // see "Handling differences" below
  "score_log":    [any, ...]        // raw — always empty on our fixtures
}
```

## ProjectMetadata

| Key | Type | Default / example |
|-----|------|-------------------|
| `_type` | string | `"ProjectMetadata"` |
| `title` | string | `"base"` (from the FLP project name) |
| `artists` | string | `""` (empty default) |
| `genre` | string | `""` |
| `comments` | string | `""` |
| `format` | string enum | `"project"` / `"pattern"` / `"score"` |
| `ppq` | int | `96` |
| `tempo` | float | `120.0` |
| `time_signature` | `TimeSignature` \| null | null when default 4/4 |
| `main_pitch` | int | `0` |
| `main_volume` | int \| null | null when unset |
| `pan_law` | int | `0` |
| `looped` | bool | `false` |
| `show_info` | bool | `false` |
| `url` | string \| null | usually null |
| `data_path` | `path` \| null | `{"_type":"path","value":"."}` |
| `created_on` | `datetime` \| null | `{"_type":"datetime","iso":"2026-04-16T17:25:26.422000"}` |
| `time_spent` | `timedelta` \| null | `{"_type":"timedelta","seconds":364.01}` |
| `version` | `FLVersion` | see below |

### FLVersion

```jsonc
{
  "_type": "FLVersion",
  "major": 25,
  "minor": 2,
  "patch": 4,
  "build": 4960
}
```

### TimeSignature (when present)

```jsonc
{
  "_type": "TimeSignature",
  "numerator": 4,
  "denominator": 4
}
```

## Channel

| Key | Type | Example / default |
|-----|------|-------------------|
| `_type` | string | `"Channel"` |
| `iid` | int | `0` |
| `kind` | string enum | `"sampler"` / `"instrument"` / `"layer"` / `"automation"` / `"audio"` / `"unknown"` |
| `name` | string \| null | `"Sampler"` / `"Kick"` / `"SerumTest"` |
| `sample_path` | `path` \| null | `{"_type":"path","value":"%FLStudioFactoryData%/..."}` |
| `plugin` | `Plugin` \| null | null on plain samplers; Plugin object on instrument channels |
| `color` | `RGBA` \| null | always present on fresh FL 25 (default gray) |
| `pan` | float | `1.0` = centre; range `0.0`–`2.0` |
| `volume` | float | `0.78125` = FL's default (`10000/12800`); range `0.0`–`1.0` |
| `enabled` | bool | `true` |
| `muted` | bool | `false` — Python's flag; **we don't decode this yet** |
| `target_insert` | int \| null | null when not routed to a specific insert |
| `automation_points` | `AutomationPoint[]` | `[]` on fresh projects |

### Plugin

```jsonc
{
  "_type": "Plugin",
  "name": "Serum",                   // VST: hosted product name; native: internal_name
  "vendor": "Xfer Records" | null,   // VST only; null on natives
  "is_vst": true,                    // true for Fruity-Wrapper-hosted, false for natives
  "state": null                      // typed plugin-state dict or null
}
```

### RGBA

```jsonc
{
  "_type": "RGBA",
  "red":   0.25490196...,  // 0..1, FL raw int / 255
  "green": 0.27058823...,
  "blue":  0.28235294...,
  "alpha": 0.0
}
```

### path wrapper

```jsonc
{ "_type": "path", "value": "..." }
```

## Pattern

| Key | Type | Example / default |
|-----|------|-------------------|
| `_type` | string | `"Pattern"` |
| `iid` | int | `1` (Python uses `iid`; TS's raw model calls it `id`) |
| `name` | string \| null | `"P1"` / null |
| `color` | `RGBA` \| null | null unless user touched it |
| `length` | int | PPQ ticks; `0` = project default bar |
| `looped` | bool | `false` unless user enabled loop |
| `notes` | `Note[]` | per-pattern note records |
| `controllers` | `Controller[]` | `[]` unless automation was wired |

### Note (Python's surface; TS raw has more fields — projector drops the extras)

| Key | Type | Example |
|-----|------|---------|
| `_type` | string | `"Note"` |
| `position` | int | `0` |
| `length` | int | `48` |
| `key` | int | `63` |
| `channel_iid` | int | `1` |
| `pan` | int | `64` |
| `velocity` | int | `100` |
| `fine_pitch` | int | `120` |
| `release` | int | `64` |

Python's `flp-info` does NOT expose Note.flags, Note.group,
Note.midi_channel, Note.mod_x, Note.mod_y — the underlying parser
exposes them, but the `flp-info` JSON encoder skips them. The TS
presentation layer mirrors that omission.

## Mixer

```jsonc
{
  "_type": "Mixer",
  "inserts": MixerInsert[]
}
```

### MixerInsert

| Key | Type | Default |
|-----|------|---------|
| `_type` | string | `"MixerInsert"` |
| `index` | int | `0` (master) through `N` |
| `name` | string \| null | null unless renamed |
| `color` | `RGBA` \| null | null on unchanged inserts |
| `enabled` | bool | `true` |
| `locked` | bool | `false` |
| `pan` | int \| null | null default |
| `volume` | int \| null | null default |
| `stereo_separation` | int \| null | null default |
| `slots` | `MixerSlot[]` | 10 slots per insert on FL 25 |
| `routes_to` | int[] | list of **destination insert indices** |

### MixerSlot

```jsonc
{
  "_type": "MixerSlot",
  "index": 0,
  "enabled": true,             // default; reflects per-slot enable bit from MixerParams
  "plugin": Plugin | null
}
```

## Arrangement

| Key | Type |
|-----|------|
| `_type` | string (`"Arrangement"`) |
| `index` | int |
| `name` | string \| null |
| `tracks` | `Track[]` |
| `timemarkers` | `TimeMarker[]` |

### Track (FL 25 base = 500 tracks, all empty by default)

| Key | Type | Default |
|-----|------|---------|
| `_type` | string | `"Track"` |
| `index` | int | 1-based (1..500) |
| `name` | string \| null | null |
| `color` | `RGBA` \| null | default gray on every fresh track |
| `height` | float | `1.0` |
| `muted` | bool | `false` |
| `items` | `ClipItem[]` | `[]` on empty tracks |

### TimeMarker (when present)

| Key | Type |
|-----|------|
| `_type` | `"TimeMarker"` |
| `position` | int |
| `name` | string \| null |
| `numerator` | int \| null |
| `denominator` | int \| null |

### ClipItem

(pattern-clip / audio-clip / automation-clip — subtypes differ; document
as they appear in fixtures.)

## OpaqueEvent (handling-differences field)

```jsonc
{
  "_type": "OpaqueEvent",
  "event_id": 84,
  "sha256": "...",
  "size": 20,
  "hint": null | string
}
```

**Drift expectation:** `opaque_events` content will NOT match 1:1 across
parsers — the set depends on which opcodes each parser has typed.
Runner treats this field specially: compares event counts and total
payload size but not individual hash hits.

## `score_log`

Always an empty list on our fixtures. Kept as raw bytes in `flp-info`.
Expected: both sides emit `[]`; runner treats as strict match.

---

## Unit normalisations the presentation layer applies

| TS raw field | Python-shape field | Mapping |
|--------------|-------------------|---------|
| `color.{r,g,b,a}` (0..255 int) | `{red, green, blue, alpha}` (0..1 float) | `raw / 255` |
| `levels.pan` (0..12800 int, 6400 centre) | `channel.pan` (0..2 float, 1.0 centre) | `raw / 6400` |
| `levels.volume` (0..12800 int, 10000 default) | `channel.volume` (0..1 float, 0.78125 default) | `raw / 12800` |
| `arrangement.id` | `arrangement.index` | rename |
| `pattern.id` | `pattern.iid` | rename |
| `channel.plugin.internalName` | `channel.plugin.name` (native) | rename; VST case uses `plugin.name` |

## Pass 2 closure log

Initial Pass 2 run: 0/85. Final: **83/85** after these decoder /
presentation-layer commits:

### Metadata decoders landed
- `0xC2` title → `metadata.title`
- `0xED` timestamp (float64 Delphi days) →
  `created_on.iso` + `time_spent.seconds`
- `0x09` loop-active → `metadata.looped`
- `0x0A` show-info → `metadata.show_info`
- `0xC3` comments → `metadata.comments`
- `0xC5` url → `metadata.url`
- `0xC6` RTF comments → `metadata.comments` fallback
- `0xC7` FL version (ASCII) → `metadata.version`
- `0x9F` FL build → `metadata.version.build` upgrade
- `0xCA` data path → `metadata.data_path`
- `0xCE` genre → `metadata.genre`
- `0xCF` artists → `metadata.artists`
- `0x50` main pitch (int16 signed) → `metadata.main_pitch`

### Channel decoders landed
- `0x16` routed-to (int8) → `channel.target_insert`
- `0xEA` channel automation (keyframe stream) →
  `channel.automation_points`

### Arrangement / mixer decoders landed
- `0xEE` per-track data (70-byte struct) → per-track
  `iid / color / icon / enabled / height / locked`
- `0xEF` track name → per-track `name`
- Per-track playlist-item redistribution from `arrangement.clips`
  via `track_idx = 499 - clip.track_rvidx`
- `0xE1` MixerParams sparse-indexed records → insert
  `pan / volume / stereo_separation` + slot `enabled / mix`
- Slot-level VST wrapper extraction
  (`internalName === "Fruity Wrapper"` + 0xD5) →
  `pluginVstName / pluginVendor`

### Presentation-layer semantic mirrors
- Two-pass metadata decode: scan 0xC7 first to determine FL
  version, then thread `legacy` flag through every walker so
  text events decode as ASCII (FL <11.5) vs UTF-16LE (FL 11.5+)
- `pythonRound` helper — JS `Math.round` rounds half up, Python's
  `round()` uses banker's rounding. AutomationPoint positions
  need banker's to match.
- `normalisePath` — POSIX trailing-slash strip only (`/`), preserve
  Windows `\` (Python on macOS uses `PurePosixPath`).
- Datetime microsecond rounding — `new Date(float)` truncates,
  Python's `timedelta` round-to-nearest; `Math.round` before Date.
- `slot.enabled` hardcoded `true` — a quirk of the reference
  Python adapter (it can't read the SlotEnabled bit out of the
  slot's params record, falls back to `True`). Mirror.
- `insert.enabled / locked` default `false` (not `true` / `false`
  native) — the reference adapter returns None when the
  insert-flags event can't be parsed (FL 9 5-byte payloads vs the
  FL 25 12-byte layout), then coerces `bool(None) = False`.
  Mirror.
- `slot.plugin` keyed strictly off 0xD5 presence (not 0xCB name).
  Slots with a 0xCB rename but no 0xD5 state blob return None in
  Python.
- Layer / Automation / Unknown-kind channel filters — the
  reference adapter returns None for `target_insert` / `sample_path`
  on channel kinds that don't expose those properties.
- `version.build: null` when 0xC7 is 3-component AND no 0x9F
  fallback.
- Post-walk channel-name scan — the reference parser returns the
  first plugin/channel-name event across the channel's full
  subtree (`0x40` to next `0x40`), even events that fire in the
  mixer section. Our main walker closes channel scope at
  `0x93`/`0xEC`; a second pass finds first `0xCB` per channel
  range and overrides.

### Remaining drift (2 files)

1. `h1_86.flp insert[19].slots[0].plugin.vendor`: TS extracts
   "FabFilter" from the VST wrapper blob, Python emits `null`.
   Likely a cross-slot blob artefact; our extraction is arguably
   more faithful.
2. `Astes - Bien Duro.flp`: PY_ERROR — `flp-info` crashes on
   this file (not a TS issue).
