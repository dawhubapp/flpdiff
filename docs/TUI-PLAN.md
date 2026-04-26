# TUI plan (post-v1)

DAW-like rich terminal UI for `flpdiff`. **Not in v1.0.** This document
sketches scope + library choice + open questions so it's picked up
cleanly when work starts.

## Why

The canonical `renderSummary` text output is perfect for:

- CI pipelines (exit code + grep-able text)
- `git diff *.flp` (textconv / external-diff)
- Scripting (`jq` over `--format=json`)

It's less good for humans scrolling a long diff: a 300-line diff
listing every clip move on a 20-track arrangement is a wall of text.
A TUI with panes, navigation, and drill-down would make `flpdiff` feel
like a real DAW-native tool.

## Library choice: Ink

[Ink](https://github.com/vadimdemedes/ink) — React for terminals.
Used by GitHub Copilot CLI, Gemini CLI, Cloudflare Wrangler, Shopify
CLI, Claude Code. Mature, good DX, component model maps 1:1 onto
diff panes.

**Alternatives considered:**

- `blessed` — older, lower-level, harder to maintain. No.
- Raw ANSI + readline — technically possible, practically painful. No.
- Rust `ratatui` or Go `bubbletea` — not a TS project. No.

Bun handles JSX natively; no build step needed. Adds ~2 MB to the
standalone binary (React + Ink + deps). Keeps the single-binary
distribution story.

Cross-platform: Ink works on macOS + Linux + Windows Terminal. Legacy
Windows `cmd.exe` users get reduced Unicode / colour support — we
document that and recommend Windows Terminal for the full experience.

## Three scope levels

### Level 1 — Scrollable diff browser (2–3 days)

Single-pane fancy pager over the existing `renderSummary` output.

- Summary line pinned at top.
- Scrollable list of changes grouped by entity type.
- Colour-coded `+` / `-` / `~` markers (already in the canonical text).
- Keyboard: `j`/`k` scroll, `tab` cycles sections, `/` filter, `q` quit,
  `?` help overlay.
- Entry point: `flpdiff tui A.flp B.flp`.
- Falls back to `renderSummary` stdout when stdout isn't a TTY.

Reads straight from `DiffResult` — zero changes to the diff engine.
Low risk, real UX improvement for scanning long diffs.

### Level 2 — DAW-like split layout (2 weeks)

Four-pane resize-aware layout:

```
┌────────────────┬─────────────────────────────────────────┐
│ CHANNELS       │ INSPECTOR                               │
│ ~ Kick  78→100 │                                         │
│ + Dub Vocal    │  (drills down based on focus in other   │
│ ~ Hat   …      │  panes — selected channel's properties, │
│                │  selected pattern's piano roll, etc.)   │
├────────────────┼─────────────────────────────────────────┤
│ MIXER          │ ARRANGEMENT                             │
│ [Master]       │ Track 'vocals'   ████░░░░███░░████░     │
│ [Insert 1] ~   │ Track 'drums'    ░░░░████░░░░░░░░░      │
│ [Insert 2]     │ Track 'bass'     ████████████████       │
│ [Insert 8] +   │                   ↑ time →              │
└────────────────┴─────────────────────────────────────────┘
Summary: 4 changes  |  j/k nav  tab focus  /filter  ?help   q quit
```

- **Channels pane**: one row per channel. Kind icon (`∿` sampler,
  `⊙` instrument, `↯` automation, `▤` layer), change marker,
  volume/pan delta as sparkline or `before → after` bar.
- **Mixer pane**: insert strips. Volume bar (vertical Unicode blocks),
  pan numeric delta, slot list with plugin-swap arrows. Focus-to-drill
  into slot detail.
- **Arrangement pane**: horizontal track rows, clip blocks coloured
  by diff state. Clip-collapse groups rendered as bracketed spans
  with count label. Zoom in/out with `+` / `-` (beats per char).
- **Inspector pane**: context-sensitive. Channel selected → property
  table. Pattern selected → note stats + mini piano roll. Insert
  selected → slot / plugin details.
- Tab / Shift-Tab cycles focus between panes. Arrow keys inside a pane.

Biggest UX payoff for the line-of-work.

### Level 3 — Piano roll + full fidelity (3–4 weeks)

Terminal-cell-constrained visual fidelity. Diminishing returns
beyond level 2 — probably better served by the (deferred) browser
viewer.

- **Piano roll**: 2D Unicode-block grid, rows = pitch, cols = time,
  velocity-shaded cells. Added notes green, removed red, moved as
  fade+arrow. Scrollable + zoomable.
- **Automation-curve view**: ASCII line chart with old curve as dim
  dotted line, new as solid, keyframe changes marked.
- **Side-by-side mode**: split every pane into old/new halves so
  before/after is visible simultaneously.
- **Diff-preview-on-hover**: in non-TUI terminals that support it
  (iTerm2 imgcat, Kitty), ship a small PNG preview of the pattern's
  note grid.

Probably worth doing some, skipping some — the note piano roll
specifically, since that's the most commonly requested view. The
side-by-side mode is cheap and valuable. Automation line chart is
medium effort.

## Shared architecture concerns

**`DiffResult` stays the single source of truth.** The TUI reads
from `compareProjects(...)` same as the text formatter. Splitting
renderers is already clean; TUI just adds a third one.

**`renderSummary` stability is non-negotiable.** Git textconv +
parity harness + MD5-compare tests all depend on its byte-stability.
No new TUI-only features should leak wording into `renderSummary`.

**Terminal feature detection:**

- `NO_COLOR=1` → fall through to plain text regardless of TTY.
- stdin/stdout not a TTY → fall through to `renderSummary` stdout.
- `TERM=dumb` → same.
- Explicit opt-out: `flpdiff tui A.flp B.flp --no-tui` prints the
  canonical output.
- Explicit opt-in: `flpdiff A.flp B.flp --tui` forces TUI even under
  `NO_COLOR` (for screenshotting etc.).

**Keyboard bindings** (draft, subject to user testing):

| Keys | Action |
|:-----|:-------|
| `q`, `Esc` | Quit |
| `?`, `F1` | Help overlay |
| `Tab`, `Shift-Tab` | Cycle pane focus |
| `j`, `↓` | Scroll down |
| `k`, `↑` | Scroll up |
| `h`, `←` | Scroll left (arrangement pane) |
| `l`, `→` | Scroll right |
| `Enter` | Drill into selection (populate Inspector) |
| `Backspace` | Close Inspector drill-down |
| `/` | Filter within focused pane |
| `+` / `-` | Zoom in/out (arrangement timeline) |
| `v` | Toggle verbose (expand clip-collapse groups) |
| `o` | Toggle old/new side-by-side (level 3) |
| `Space` | Toggle diff/show-old/show-new per pane |
| `1`–`6` | Jump to section (metadata/channels/patterns/mixer/arrangement/opaque) |

**Binary size:** Ink adds ~2 MB compressed. Target stays under 70 MB
for the standalone binary. Acceptable given the audience
(GitHub-release download, not disk-space-constrained).

**Testing:** Ink components are testable with `ink-testing-library`
(renders to a string). Adds a dozen component tests; keeps the
existing 343 tests intact.

## Roadmap

- **v1.0.0** (current plan): ship canonical text output + JSON + git
  integration. No TUI. Users get real value from day one.
- **v1.1**: level 1 TUI (scrollable diff browser). Released 2–4
  weeks after v1.0 pending feedback from the launch cohort.
- **v1.2 or v2.0**: level 2 (DAW-like split layout). Depends on
  whether v1.1 gets traction.
- **Level 3 features** ship as individual enhancements, not a single
  release. Side-by-side mode first (cheap, high value). Piano roll
  last.

## Open questions

1. **Name for the TUI command** — `tui` is clear but a bit
   developer-ey. `view` / `browse` might land better. Decide before
   v1.1 ships.
2. **Colour palette** — match FL Studio's default track colours for
   familiarity, or pick a neutral terminal-friendly palette that works
   on both light + dark backgrounds? Test both.
3. **Pager fallback** — when `LESS` is available and output exceeds
   terminal height, pipe through `less -R`? (Git does this; it's a
   reasonable default.)
4. **Scriptability** — should the TUI have a `--snapshot-frame <file>`
   mode that renders one screen to a file then exits (useful for
   bug reports + docs screenshots)?
