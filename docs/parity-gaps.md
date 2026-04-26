# Diff-engine parity gaps

Tracks the known deltas between the TS `flpdiff` (Phase 3.4 port)
and the Python `flpdiff` CLI's text output. Refresh via the parity
harness in the dev-side `python/tools/parity/` of the parent project.

## Summary

| Corpus scope | MATCH | DIFF | ERROR | Notes |
|--------------|-------|------|-------|-------|
| `tests/corpus/local/diff_pairs/` | **5** | **1** | 0 | One known pre-existing gap (Kickstart VST vendor — see below). |

Across all 6 pairs, 5 produce output that MD5-matches Python's
`flpdiff --format text --no-color` byte-for-byte. Matched pairs span
FL 20 / 24 / 25 projects with real-world content — vocals, drum
chops, keyboard bounces, multi-bar arrangements — exercising every
entity family we've decoded (metadata, channels, patterns, mixer
inserts, arrangement tracks with clip-collapse groups, automation
keyframes, per-note diff with bucket-summarisation).

### Per-pair detail

| Pair | py md5 | ts md5 | Status |
|------|--------|--------|--------|
| `dorn-girls.flp` ↔ `dorn-girls_2.flp` | `f1254ddc` | `f1254ddc` | ✅ MATCH |
| `edz_chords_10.flp` ↔ `edz_chords_28.flp` | `36612c73` | `36612c73` | ✅ MATCH |
| `h1_86.flp` ↔ `h1_86_98.flp` | `c989f55d` | `a6b030ed` | ⚠ Kickstart vendor (see below) |
| `italo_bass_pop_15.flp` ↔ `italo_bass_pop_18.flp` | `4517ad63` | `4517ad63` | ✅ MATCH |
| `j1_6.flp` ↔ `j1_7.flp` | `03d5444a` | `03d5444a` | ✅ MATCH |
| `phlegma_dogs_10.flp` ↔ `phlegma_dogs_9.flp` | `c541fda5` | `c541fda5` | ✅ MATCH |

## Known gaps

### 1. Kickstart VST vendor extraction (diff + Pass 2 shared)

**Files affected:** `diff_pairs/h1_86.flp ↔ h1_86_98.flp` (likely all
projects hosting Kickstart in a slot whose name the user hasn't
changed since authoring).

**Symptom:**

```
py: Plugin swapped in slot 0: 'Kickstart' (VST) → LFOTool
ts: Plugin swapped in slot 0: 'Kickstart' (FabFilter, VST) → LFOTool
```

**Cause:** the reference Python VST-wrapper decoder returns `None`
for the vendor field on this specific file; our TS
`decodeVSTWrapper` successfully reads it from the wrapper blob's
id-length-value record stream.

**Decision:** keep TS more faithful; don't degrade the decoder to match
Python's omission. This is the same delta that shows up as
`mixer.inserts[19].slots[0].plugin.vendor: py=None ts='FabFilter'` in
the Pass 2 JSON parity harness — see `README.md` parity section.

### 2. Opaque plugin-state deltas (not yet on TS side)

**Status:** stubbed.

Python's diff engine emits `OpaqueChange` objects when the `0xD5` plugin
state blob changes — with SHA-256 fingerprints + byte-length deltas —
and routes them into the `Opaque blobs` section of the rendered summary
when the plugin-state registry can't dispatch them to a typed decoder.
The TS side currently emits `opaqueChanges: []` for every project. When
a plugin-state registry lands (future commit, parallel to Python's
`flp_diff.plugins`), wire it up at `DiffResult.opaqueChanges` and
extend this harness.

## Refreshing the numbers

```sh
.venv/bin/python python/tools/parity/run_diff_parity.py tests/corpus/local/
```

Output shape:

```
[MATCH] A.flp vs B.flp  (py=1/<md5> ts=1/<md5>)
[DIFF ] C.flp vs D.flp  (py=1/<md5> ts=1/<md5>)
  line N:
    py: "…"
    ts: "…"

=== N/M MATCH, K DIFF, 0 ERROR ===
```

MD5s are 8-character prefixes of the full digest — enough to spot drift
without bloating the output.

## Adding a new diff pair

Drop a pair into `tests/corpus/local/diff_pairs/` with shared name
prefix (`foo.flp` + `foo_2.flp`, or `foo_A.flp` + `foo_B.flp` — the
auto-discovery walker pairs by `stem.startswith(otherStem)`). Re-run
the harness; the pair will show up as one row in the output table.
