# flpdiff-ts

TypeScript port of [flpdiff](https://github.com/pronskiy/flpdiff).

**Status:** Phase 3.1 ✅ (mostly), Phase 3.2 ✅ (MVP). Envelope + 4 event kinds
parse; FL version / tempo / PPQ extracted and oracle-matched against
Python's `flp-info` on all 5 committed FL 25 public fixtures; `flpdiff-ts`
CLI compares two files and exits with Python-compatible codes. 21 tests,
78 assertions, tsc clean. Phase 3.3 (entity coverage) is next.

This repo is a nested git repo alongside the main Python `flpdiff` codebase.
It exists to explore two asymmetric wins that Python cannot deliver cheaply:

1. **Clean-room FLP parser** — no dependency on the reference parser (GPL-3 reference).
2. **Browser-native diff viewer** — `.flp` files parsed and diffed entirely
   in the browser, no install.

Python remains the canonical product and continues to ship on its own
schedule. This port has an explicit go/no-go gate at Phase 3.6 before any
production commitment is made. See the spec 
for the full plan and exit guardrails.

## Principles

- **No the reference parser source referenced** during parser development. Format knowledge
  derives from `docs/flp-format-spec.md`, the dev repo's harness notes,
  and direct byte inspection of committed fixtures. One the reference parser cross-check
  has been performed — for the `0x36 → utf16_zterm` format fact (see
  `docs/parser-architecture.md` for the clean-room boundary).
- **Oracle testing** against Python's `flp-info` is the correctness check.
  All five FL 25 public fixtures currently match on headline fields
  (version, tempo, PPQ, event-kind coverage).
- **Byte-offset error context from day one.** Every custom `Schema.read()`
  is wrapped in `annotateRead` — malformed FLPs produce errors with
  absolute byte offset, schema name, opcode, event index, nesting path,
  and a 16-byte hex-dump of preceding bytes. Not retrofitted.
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

## Repo layout

```
ts/
├── package.json           # flpdiff-ts, bun + typed-binary
├── tsconfig.json
├── docs/
│   ├── parser-architecture.md   # typed-binary + custom-schemas + error infra
│   └── flp-format-spec.md       # clean-room FLP format spec
├── src/
│   ├── index.ts           # public exports
│   ├── cli.ts             # flpdiff-ts CLI
│   ├── parser/
│   │   ├── errors.ts      # FLPParseError + annotateRead
│   │   ├── primitives.ts  # VarIntSchema, Utf16LeStringSchema, helpers
│   │   ├── event.ts       # FLPEventSchema + FL25_OVERRIDES
│   │   └── flp-project.ts # parseFLPFile, getFLVersionBanner, getTempo
│   └── diff/
│       └── headline.ts    # pure diffHeadlines + renderHeadlineDiff
└── tests/
    ├── smoke.test.ts      # parametrized over 5 public fixtures
    └── cli.test.ts        # CLI + pure diff-logic coverage
```

## Scope by phase

| Phase | What it covers                                     | Status |
|-------|-----------------------------------------------------|--------|
| 3.1   | Scaffold + error infra + format spec                | ✅ (4/5) |
| 3.2   | Headline MVP (envelope + version + tempo + PPQ)     | ✅ (3/4) |
| 3.3   | Entity coverage (channels, patterns, mixer, etc.)   | 🔲 |
| 3.4   | Port the diff engine from Python                    | 🔲 |
| 3.5   | Browser viewer                                      | 🔲 |
| 3.6   | Go/no-go gate                                       | 🔲 |
