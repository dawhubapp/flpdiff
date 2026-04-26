# Contributing

Contributions welcome. This project is built in public and accepts PRs
+ issues on GitHub.

## Bug reports

The most useful bug report includes:

1. **Which FL Studio version** saved the file. `flpdiff info <file>`
   prints it on the second line (`FL Studio 25.2.4.4960 | …`).
2. **Output of `flpdiff info <file> --format=json`** — attach as a
   file or paste into a `<details>` block.
3. **The `.flp` file itself if you can share it.** If the file is
   proprietary / stems-heavy, a minimal repro (blank project saved
   from the same FL version + the one problematic channel/plugin)
   works almost as well.
4. **What you expected** vs **what `flpdiff` printed**.

For diff bugs specifically, include both `A.flp` and `B.flp` — the
issue is almost always on a specific entity pair, and we need both
sides to reproduce.

## Pull requests

1. **Open an issue first** for non-trivial changes. Quick typo fixes
   and obvious bugs can skip this.
2. **Run the test suite** before submitting: `bun test`. All tests
   must pass; new functionality needs new tests.
3. **Typecheck cleanly**: `bun run typecheck`.
4. **Match the existing style** — no need for a formatter config, just
   eyeball the surrounding code.
5. **One logical change per PR.** Separate commits for the feature
   itself and any refactors that touch unrelated files.

## Format discoveries

If you've reverse-engineered an opcode, event layout, or FL-version
quirk that `flpdiff` doesn't yet decode:

1. **Document the format fact** in `docs/flp-format-spec.md` — opcode,
   payload layout, observation method.
2. **Decode it in `src/parser/project-builder.ts`** (or a dedicated
   decoder under `src/model/`).
3. **Cross-check against at least two independent FLPs** exhibiting
   the feature.
4. **Clean-room discipline**: format facts (opcode numbers, payload
   shapes, enum values) are fine to cite. Code, class names, and
   internal data structure names from existing GPL libraries are
   off-limits. See `docs/flp-format-spec.md` for the policy.

## Tests

Tests live under `tests/` and use Bun's test runner. Patterns:

- **Parser tests** should exercise both the happy path on a real
  fixture and the decoder's edge cases on a crafted payload.
- **Diff-engine tests** should assert on the exact `humanLabel` string
  when that's the user-visible output. We cross-check against the
  Python reference during development.
- **Fixture tests** go under `tests/corpus/re_base/fl25/` (committed,
  synthetic, FL 25.2.4 saves). Personal / non-redistributable files
  stay in `tests/corpus/local/` (gitignored).

## Code of conduct

Be decent. Technical disagreements fine; personal attacks not.
