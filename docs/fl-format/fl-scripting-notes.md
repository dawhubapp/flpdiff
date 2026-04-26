# FL Studio 25 — MIDI Scripting Sandbox Notes

Empirically established while building the Phase 1.2 RE harness. Rules apply to **FL Studio Producer Edition v25.2.4 [build 4960]** on macOS; behavior may differ on Windows or other FL versions.

## Setup prerequisites

1. **IAC Driver must be enabled.** FL Studio only instantiates MIDI scripts when a MIDI input device is selected. On macOS that means Apple's built-in IAC Driver.
   - Open `/Applications/Utilities/Audio MIDI Setup.app`
   - Window → Show MIDI Studio
   - Double-click **IAC Driver** → tick **"Device is online"** → keep default "Bus 1" → Apply
   - In FL: Options → MIDI Settings → select **IAC Driver Bus 1** in the Input list → **Enable** → set **Port** (any number) → **Controller type**: `flpdiff-harness`

2. **Accessibility perms for the automating terminal** (Terminal / iTerm / IDE). Required for `osascript`-driven clicks (Save menu, Reload script button). `pyautogui.moveTo` is a quick verification.

3. **Script install path**: `~/Documents/Image-Line/FL Studio/Settings/Hardware/flpdiff-harness/device_flpdiff_harness.py` (symlink from the repo keeps source-of-truth singular).

## Sandbox constraints (the hard-won map)

| Operation | Works? | Notes |
|---|---|---|
| `open(path, "w")` | ✅ | Create new files freely inside FL's own tree. |
| `f.write(bytes)` | ✅ | Single-write reads treated as atomic at the APFS syscall level for small payloads. |
| `os.makedirs(path)` | ⚠️ | Works **inside FL's existing tree** (e.g. `~/Documents/Image-Line/FL Studio/Settings/Hardware/...`). **Fails silently** under fresh `~/Documents/<name>/` subdirs or anywhere under `~/Library/Application Support/` — returns NULL without raising a Python exception, surfaces as `SystemError: <built-in function mkdir> returned NULL without setting an exception`. |
| `os.remove` / `os.unlink` | ❌ | `<class '_io.FileIO'> returned NULL without setting an exception`. |
| `os.replace` (rename) | ❌ | Same NULL pattern. Rules out any tmp-file + atomic-rename idiom. |
| `os.path.exists`, `os.path.isdir`, `os.listdir` | ✅ | Reads are unrestricted. |
| `__file__` | ❌ | Not set by FL's loader. Hardcode paths or use env var. |
| `transport.globalTransport(FPT_Save=50, 1)` | ⚠️ | Returns without raising, but the file is **not flushed to disk**. Use accessibility save instead. |
| `os.environ.get(...)` | ✅ | FL passes environment through from the parent `open` call. |
| `print(...)` | ✅ | Goes to View → Script output. Use for all logging. |
| `traceback.format_exc()` | ✅ | Invaluable; standard bare-exception repr loses info on C-level NULL failures. |

### Why these matter

Every "❌" above dictated a design decision in the harness:

- **No rename** → `_write_result` writes directly to its final path; the orchestrator tolerates torn reads via JSON-parse retry.
- **No delete** → `_archive` is a stub; inbox accumulates processed commands. `_pending_commands` filters by "has matching result" so stale commands aren't re-processed.
- **Limited `makedirs`** → runtime dir sits inside FL's own settings tree. Both orchestrator and script hardcode the same path.
- **Save is broken from scripts** → orchestrator drives save via AppleScript clicking the menu item (`tools/re_harness/autodrive.save_via_menu`).

## Confirmed FL scripting API surface (FL 25.2.4)

Discovered live via the `describe` and `list_apis` handlers. The first dump below is the full list of public callables with `"set"` in the name, captured on **2026-04-17** from FL 25.2.4 build 4960. Items with notes have been verified end-to-end.

### Full setter inventory (from `list_apis` handler)

**`channels`** — 8 setters:
`setChannelColor`, `setChannelName`, `setChannelPan`, `setChannelPitch`, `setChannelVolume`, `setGridBit`, `setStepParameterByIndex`, `setTargetFxTrack`.

**`general`** — 6 setters:
`setDenominator`, `setNumerator`, `setRecPPQ`, `setUndoHistoryCount`, `setUndoHistoryLast`, `setUndoHistoryPos`.
*Notably missing:* `setProjectTitle` — despite `getProjectTitle()` existing, there's no setter.

**`mixer`** — 16 setters:
`setActiveTrack`, `setCurrentTempo`, `setEqBandwidth`, `setEqFrequency`, `setEqGain`, `setPluginMixLevel`, `setPluginMuteState`, `setRouteTo`, `setRouteToLevel`, `setSlotColor`, `setTrackColor`, `setTrackName`, `setTrackNumber`, `setTrackPan`, `setTrackStereoSep`, `setTrackVolume`.

**`patterns`** — 5 setters (includes one getter-shaped-name):
`getBlockSetStatus`, `setChannelLoop`, `setLoopStarterRootNote`, `setPatternColor`, `setPatternName`.

**`plugins`** — 13 methods total; the setter + preset nav ones that matter:
- `plugins.setParamValue(value, paramIndex, index, slotIndex=-1)` — **the primary plugin-parameter setter.** `value` is a normalized float 0.0-1.0. `index` is the channel-rack index (with `slotIndex=-1`) or the mixer-insert index (with `slotIndex=0..9`).
- `plugins.nextPreset(index, slotIndex=-1)`, `plugins.prevPreset(index, slotIndex=-1)` — cycle through the plugin's presets.
- Read-only companions: `getName`, `getPluginName`, `getParamCount`, `getParamName`, `getParamValue`, `getParamValueString`, `getPresetCount`, `getColor`, `getPadInfo`, `isValid`.

This module was documented at <https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm#script_module_plugin>. Earlier notes claimed plugin-internal state was only settable via GUI automation — that was wrong; `setParamValue` works end-to-end. Verified on Serum MasterVol (base_one_serum.flp, channel 1): set → save → diff cleanly changes only opcode `0xd5` (plugin state).

**RE case study — Fruity Parametric EQ 2 (2026-04-17).** Using `plugins.setParamValue` + the binary-diff harness, we mapped all 36 EQ 2 parameters against a real instance in the author's local corpus (insert 13 slot 4 of `edz_chords_28.flp`). Methodology:

1. Start from a known-state FLP with the plugin loaded. EQ 2 can't be loaded *onto* a slot from scripting, so the plugin has to be pre-loaded in the base.
2. Establish a noise baseline: two saves at the same parameter values. The 0xd5 payloads that differ in this pair are "save-noise" (session state, timers).
3. For each parameter: `setParamValue` to `v1`, save → snap A. `setParamValue` to `v2`, save → snap B. Byte-diff the 0xd5 payloads at the same event-index in both snaps.
4. Position-aligned 0xd5 comparison: there are many 0xd5 events (one per plugin on every slot), so isolate by event index. A "clean hit" is a payload that's identical in the noise-pair but different in the real-pair — there should be exactly one such payload per parameter sweep.

EQ 2's layout turned out to be uniform 4-byte slots: `level[7]:u16`, `freq[7]:u16`, `width[7]:u16`, `type[7]:u8`, `order[7]:u8`, `main_level:u16`, with zero padding in each slot. Scale factor: `value * 0xFFFF == normalized float 0-1`. Full map in `src/flp_diff/plugins/fruity_eq2.py`.

**What didn't work (yet) for Serum.** Same mechanism (`setParamValue` works fine), but Serum's VST state blob changes size across same-value saves — session-internal state like timers, preset-browser position, etc. serialize non-deterministically. The fixed-offset RE approach assumes a stable size + stable layout, so Serum needs a different technique (per-param noise differencing, or a VST fxChunk reader) — deferred.

**`transport`** — 3 setters:
`setLoopMode`, `setPlaybackSpeed`, `setSongPos`.

**`ui`** — 6 setters:
`setBrowserAutoHide`, `setFocused`, `setHintMsg`, `setSnapMode`, `setStepEditMode`, `setTimeDispMin`.

### Verified end-to-end

- `mixer.getCurrentTempo()` / `mixer.setCurrentTempo(raw)` — `raw = bpm × 1000`. Set → save → reread → match confirmed on all 5 base fixtures.
- `mixer.trackCount()` — returns number of **used** inserts (not the 127 max).
- `channels.channelCount()` — count of channel-rack entries.
- `patterns.patternCount()` — count.
- `general.getProjectTitle()` — returns `""` when the project has no title.
- `general.getCurrentFilename()` — **does not exist**. No direct way to discover the currently-open FLP path from inside a script. Caller controls the path externally.
- `ui.getVersion()` — returns strings like `"Producer Edition v25.2.4 [build 4960]"`.
- `transport.globalTransport(cmd, value)` — accepts the call, but `FPT_Save=50` doesn't flush. Other opcodes unvalidated.

### High-value RE targets (discovered, not yet wired into handlers)

Each of these maps to a Phase 1.2.5 registry candidate — sweep the value, binary-diff, land the opcode mapping.

| Target | API call | Phase 1.2.1 handler |
|---|---|---|
| Time signature | `general.setNumerator(n)`, `general.setDenominator(d)` | `set_time_signature` |
| Channel volume | `channels.setChannelVolume(iid, v)` | `set_channel_volume` |
| Channel pan | `channels.setChannelPan(iid, v)` | `set_channel_pan` |
| Channel name | `channels.setChannelName(iid, name)` | `set_channel_name` |
| Mixer insert volume | `mixer.setTrackVolume(idx, v)` | `set_insert_volume` |
| Mixer insert name | `mixer.setTrackName(idx, name)` | `set_insert_name` |
| Pattern name | `patterns.setPatternName(iid, name)` | `set_pattern_name` |
| Insert EQ (built-in) | `mixer.setEqFrequency/setEqGain/setEqBandwidth(...)` | `set_eq_*` — directly unblocks Fruity Parametric EQ 2 RE (1.2.8) |

## Automation helpers (AppleScript / `osascript`)

All in `tools/re_harness/autodrive.py`. They use the macOS accessibility API, which is why the repo requires Accessibility permissions up front.

| Helper | Does |
|---|---|
| `activate_fl_studio()` | `tell application "FL Studio" to activate`. Safe to call repeatedly. |
| `ensure_script_output_open()` | Opens View → Script output via `click menu item`. Required before clicking the Reload button. |
| `reload_midi_script()` | Clicks the **Reload script** button in the Script output window. Triggers fresh `OnInit()`. |
| `open_flp(path)` | `open -a "FL Studio 2025.app" <path>`. Bundle name is auto-detected by globbing `/Applications/FL Studio*.app` and picking the highest version. Override via `FLPDIFF_FL_APP`. |
| `save_via_menu()` | Clicks File → Save. Sends an Enter keystroke afterward to dismiss any confirmation prompt (FL occasionally shows "Save a copy?" style dialogs). |

## Troubleshooting

- **`[flpdiff-harness] processing error: <class '_io.FileIO'> returned NULL`** — a blocked syscall. Check which line the traceback points at; compare against the table above.
- **`[flpdiff-harness] cannot use directory ...`** — FL's sandbox refused a write probe. Almost always means the path isn't under FL's Hardware tree.
- **Script output window empty, no "[flpdiff-harness] started"** — script never initialized. Usually: (a) IAC Driver not enabled, (b) no MIDI Input selected in FL, or (c) OnInit threw a real exception (reload and read the traceback).
- **Handshake TimeoutError** — script isn't polling. Reload it, or restart FL. Also verify the inbox path in FL's console line matches `DEFAULT_RUNTIME_ROOT` in `tools/re_harness/ipc.py`.
- **`open -a "FL Studio"` returns exit 1** — bundle name in `/Applications/` is version-specific (`FL Studio 2025.app`, `FL Studio 2024.app`, …). The auto-detect handles this; if you hit it, something changed the bundle name or location.
- **Save doesn't modify the FLP** — means the Save menu click didn't reach FL (focus issue), or FL showed a Save-As dialog that dismissed with the default button (Cancel, not Save). Watch the UI while `cycle.py --auto` runs.

## What we do NOT rely on

- **FL Studio Remote (WebSocket)** — not explored; MIDI scripting + file IPC turned out to be enough.
- **Scripting-driven Open** — no FL API exists to open an arbitrary FLP from a path. We use `open -a` from the orchestrator instead.
- **Scripting-driven Save-As** — no API for path-aware save. We compensate by controlling which file FL has open.
- **Hot-reload of the script via file mtime** — FL 25's scripting engine doesn't watch for edits; you must click Reload script (or use `reload_midi_script()`).

## Future FL versions

When testing against a new FL Studio release:

1. Run the `describe` handler — the API surface may have gained new methods (`general.getCurrentFilename` would be a big win).
2. Re-probe the sandbox: write a quick script that tries `os.remove`, `os.replace`, etc. If they start working, the harness can drop its workarounds.
3. Re-check the save-from-scripting path (`transport.globalTransport(FPT_Save)`). If a new build fixes it, remove the AppleScript detour.

Keep this doc updated with anything new — future maintainers will thank us.
