# Test corpus

Test FLP files live here. The layout:

- `re_base/fl25/` — **committed.** Synthetic base FLPs saved from FL
  Studio 25.2.4 for parser regression. Used by the public test suite.
- `local/` — **gitignored.** Drop your personal FLP files here for
  development-machine parser testing. Never commit real user projects.
  Suggested structure:

  ```
  local/
  ├── fl12/
  ├── fl20/
  ├── fl21/
  ├── fl24/
  └── fl25/
  └── diff_pairs/   # paired before/after FLPs for diff-engine tests
  ```

The committed re_base fixtures cover happy paths; the gitignored
local corpus is where edge-case fidelity is exercised on real-world
projects spanning FL 9–25.

## Running tests

```bash
bun test
```

The local-corpus tests are skipped when `tests/corpus/local/` is
empty, so a fresh checkout passes without it.
