# flpdiff-ts

TypeScript port of [flpdiff](https://github.com/pronskiy/flpdiff).

**Status:** scaffolding. Parser not started.

This repo is a nested git repo alongside the main Python `flpdiff` codebase.
It exists to explore two asymmetric wins that Python cannot deliver cheaply:

1. **Clean-room FLP parser** — no dependency on the reference parser (GPL-3 reference).
2. **Browser-native diff viewer** — `.flp` files parsed and diffed entirely
   in the browser, no install.

Python is the canonical product and continues to ship on its own schedule.
This port has an explicit go/no-go gate at Phase 3.6 before any production
commitment is made. See the spec  for the full
plan and exit guardrails.

## Principles

- **No the reference parser source referenced** during parser development. Format knowledge
  derives from the FLP spec document (`docs/flp-format-spec.md`, forthcoming),
  RE-harness observations, and Image-Line's public documentation.
- **Oracle testing** against Python's `flp-info --format json` is the primary
  correctness check. When TS and Python JSON match on the full corpus, the
  parser is done.
- **Bun** is the runtime and test runner. **typed-binary** handles TLV event
  parsing.

## Planned structure

```
ts/
├── package.json
├── tsconfig.json
├── src/
│   ├── parser/      # clean-room FLP reader
│   ├── model/       # mirrors the Python FLPProject shape
│   ├── diff/        # (later) diff engine port
│   └── index.ts
├── tests/
│   └── oracle.test.ts
└── docs/
    ├── flp-format-spec.md
    └── parity-gaps.md
```

Nothing here yet. Phase 3.1 scaffolding is the next step.
