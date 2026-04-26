# Security

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

Email **roman@pronskiy.com** with:

- A description of the issue
- A reproducer (ideally a minimal `.flp` file or input that triggers it)
- The flpdiff version + platform you observed it on

Typical timelines:

- **Initial acknowledgement**: within 72 hours
- **Triage + fix plan**: within 1 week
- **Patch release**: coordinated with the reporter

## Scope

flpdiff is a pure parser + diff tool. The practical surface is:

- **Parsing malformed or hostile `.flp` files** — unbounded reads,
  integer overflow, pathological recursion. Any such bug is in scope.
- **CLI injection via filenames / git invocation paths** — we shell
  out to `git` in `git-setup`, which is the main place untrusted input
  could reach a subprocess.
- **Dependency chain** — we depend on `typed-binary` + Bun's stdlib.
  Dependency CVEs that affect flpdiff are in scope.

Out of scope:

- Fuzzing finds that report crashes on genuinely corrupt inputs where
  a graceful error message is already produced (exit code 2).
- Issues in FL Studio itself or in the `.flp` format as Image-Line
  designs it.

## Fixed issues

None yet reported.
