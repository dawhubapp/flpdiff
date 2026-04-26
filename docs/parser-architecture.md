# FLP Parser Architecture (TS side)

**Status:** architectural decision, pre-scaffold.
**Date captured:** 2026-04-18.
**Scope:** how the TypeScript parser in `ts/` is structured.

This document is the architectural source of truth for the TS parser.
A *separate* `docs/fl-format/flp-format-spec.md` describes the FLP
file format itself — opcodes, event shapes, FL-version quirks. This
doc describes how we *implement* a reader for that format.

---

## Summary

- **Library:** [`typed-binary`](https://github.com/iwoplaza/typed-binary) (MIT, zero deps, ArrayBuffer-based, 184★, active as of 2026-04-04).
- **Shape:** the whole parser is expressed as typed-binary schemas. Three custom `Schema<T>` subclasses handle FLP's quirks (variable-length events, varints, UTF-16 strings); everything else uses the stock primitives.
- **Errors:** byte-offset capture on failure is written in from the first line of parser code. No "we'll add debugging later" — the cost of retrofitting a deep parser with offset context is far higher than baking it in.

---

## Why typed-binary

Evaluated against four alternatives (see bottom). The decisive properties:

| Property | Why it matters for flpdiff |
|---|---|
| Zero dependencies | Keeps the browser bundle well under the 2 MB Phase 3 guardrail |
| ArrayBuffer-based | Works identically in Node, Bun, and the browser — Epic 3's whole point |
| `bin.Parsed<typeof Schema>` type inference | Single source of truth. The schema *is* the type; no duplicated interfaces |
| Custom schemas via `Schema<T>` subclass | Escape hatch for FLP's quirks without leaving the declarative model |
| Bidirectional (read + write) | Free optionality if we later add write-side tooling (merge, migration) |
| Actively maintained, MIT | Low lock-in concerns for the horizon we care about |

## Why custom schemas (not a separate hand-rolled reader)

My first instinct was a hybrid: hand-roll the outer `FLPReader` class,
use typed-binary only for inner payloads. The hybrid framing dissolved
once I confirmed that custom `Schema<T>` subclasses can take arbitrary
control of the input stream inside their `read()` method. Anything a
hand-rolled reader could do, a custom schema can do — and stay inside
the schema model so type inference flows through.

The custom-schema API (verified against
`iwoplaza/typed-binary/packages/typed-binary/src/structure/`):

```ts
abstract class Schema<T> {
  abstract read(input: ISerialInput): T;
  abstract write(output: ISerialOutput, value: T): void;
  abstract measure(value: T, measurer?: IMeasurer): IMeasurer;
}
```

Inside `read(input)`, we have `input.readByte()` / `input.readSlice()` /
etc. and a tracked position. That's all we need for FLP's envelope.

## The three custom schemas

Only three primitives fall outside typed-binary's stock set. Everything
else (`u8`, `u16`, `u32`, `f32`, `object`, `arrayOf`, `dynamicArray`,
`tupleOf`, `concat`, `optional`) is already covered.

### `VarIntSchema`

**What:** 7-bit varint used by opcode-range 0xC0+ events to prefix their
payload length. Each byte contributes 7 bits; high bit means "more
bytes follow".

**Why a custom schema:** typed-binary has no varint primitive.

**Rough shape:**
```ts
class VarIntSchema extends Schema<number> {
  read(i: ISerialInput): number {
    let value = 0, shift = 0, byte: number;
    do {
      byte = i.readByte();
      value |= (byte & 0x7f) << shift;
      shift += 7;
      // defensive: shift > 35 indicates corruption (FLP varints
      // encode event lengths, bounded well under 2^32)
    } while (byte & 0x80);
    return value;
  }
  // write + measure implemented for symmetry; not used at parse time
}
```

### `Utf16LeStringSchema`

**What:** FL stores strings (plugin names, track names, sample paths,
etc.) as UTF-16LE, null-terminated, inside variable-length event
payloads.

**Why a custom schema:** typed-binary's `chars` is byte-oriented; it
does not handle UTF-16 encoding or null termination.

**Notes:**
- Read until `u16 == 0x0000` (null terminator).
- Use the same `surrogatepass`-style leniency the Python parser adopted
  for unpaired surrogates (see Phase 1.2.6 fork patches in the Python
  repo). Wrong surrogate pairs appear in real files saved by older FL
  versions; strict decoding loses data.
- Separate sub-schema `Utf8NullTermStringSchema` for the rare 0x36-style
  opcode that uses UTF-8.

### `FLPEventSchema`

**What:** reads a single FLP TLV event from the stream. Encapsulates
the opcode-range-based length encoding that is FLP's defining
envelope shape.

**Why a custom schema:** the length of an event depends on the *value
range* of the tag, not a separate length field:

| Opcode range | Payload length |
|---|---|
| `0x00` – `0x3F` | 1 byte |
| `0x40` – `0x7F` | 2 bytes (uint16 LE) |
| `0x80` – `0xBF` | 4 bytes (uint32 LE) |
| `0xC0` – `0xFF` | varint-prefixed, N bytes |

No declarative schema library expresses "read 1 field, branch on its
value, read 1–N additional bytes accordingly."

**Rough shape:**
```ts
type FLPEvent =
  | { kind: "u8";   opcode: number; value: number }
  | { kind: "u16";  opcode: number; value: number }
  | { kind: "u32";  opcode: number; value: number }
  | { kind: "blob"; opcode: number; payload: Uint8Array };

class FLPEventSchema extends Schema<FLPEvent> {
  read(i: ISerialInput): FLPEvent {
    const opcode = i.readByte();
    if (opcode < 0x40) return { kind: "u8",   opcode, value: i.readByte() };
    if (opcode < 0x80) return { kind: "u16",  opcode, value: readU16LE(i) };
    if (opcode < 0xc0) return { kind: "u32",  opcode, value: readU32LE(i) };
    const len = varInt.read(i);
    const payload = readBytes(i, len);
    return { kind: "blob", opcode, payload };
  }
  // ...
}
```

Payload interpretation (e.g., decoding the blob for 0x9C tempo or
0xC0 compound blobs) is a *second pass*: wrap the `payload` bytes in
a fresh `BufferReader` and run a payload-specific schema. Those
schemas are stock typed-binary — no further custom classes needed.

---

## Error handling: offset capture from day one

### Why this is a from-day-one decision

Parsing a malformed FLP and seeing `Expected uint32, got EOF` with no
location context is useless. The format has ~100 opcodes, nested
payloads inside 0xC0+ blobs, 4-bucket length encoding, and per-FL-version
quirks.

We already learned this in earlier RE work: when a real user FLP
triggered a parser warning for marker byte 9 / 11 / 6, the fix
required isolating which event, which plugin, which FL version
produced it.
Without offset context on the error, that's a binary-search-through-logs
exercise. With offset context, it's a one-shot diagnosis.

Adding offset tracking after the parser is written means retrofitting
every custom schema. The cost is always higher than baking it in
up-front.

### What gets captured on every parser error

- `byteOffsetAbsolute` — where in the file the failing read started
- `schemaName` — which schema class was executing (`FLPEvent`, `Utf16LeString`, …)
- `opcode` — the FL opcode being parsed (when inside an event)
- `eventIndex` — 0-based index of the event in the top-level stream
- `nestingPath` — e.g. `["FLPProject", "events[42]", "payload(0xC0)", "Utf16LeString"]`
- `cause` — the original error (for stack trace + message)

### Implementation pattern

A single helper at the top of `ts/src/parser/errors.ts`:

```ts
export class FLPParseError extends Error {
  constructor(public readonly ctx: FLPParseErrorContext, cause?: unknown) {
    super(formatErrorMessage(ctx, cause));
    this.cause = cause;
  }
}

export function annotateRead<T>(
  schemaName: string,
  input: ISerialInput,
  extra: Partial<FLPParseErrorContext>,
  inner: () => T,
): T {
  const start = input.currentByteOffset; // API name TBD — see Open items
  try {
    return inner();
  } catch (e) {
    if (e instanceof FLPParseError) {
      // already annotated at a deeper level — extend path, re-throw
      throw e.extend({ schemaName, byteOffsetAbsolute: start, ...extra });
    }
    throw new FLPParseError(
      { schemaName, byteOffsetAbsolute: start, ...extra },
      e,
    );
  }
}
```

Every custom `Schema.read()` wraps its body in `annotateRead`:

```ts
class FLPEventSchema extends Schema<FLPEvent> {
  read(i: ISerialInput): FLPEvent {
    return annotateRead("FLPEvent", i, {}, () => {
      const opcode = i.readByte();
      return annotateRead("FLPEvent.payload", i, { opcode }, () => {
        if (opcode < 0x40) return { kind: "u8",  opcode, value: i.readByte() };
        if (opcode < 0x80) return { kind: "u16", opcode, value: readU16LE(i) };
        if (opcode < 0xc0) return { kind: "u32", opcode, value: readU32LE(i) };
        const len = varInt.read(i);
        return { kind: "blob", opcode, payload: readBytes(i, len) };
      });
    });
  }
}
```

The top-level event-stream iterator annotates `eventIndex`. Inner
payload parsers annotate `parentOpcode` so nested failures read
"inside 0xC0 event, while parsing inner struct at offset …".

The **cost** of this pattern is cheap (one function call per schema
read) and the **result** is every error looking like:

```
FLPParseError at byte 12488, event #43, opcode 0xC0
  path: FLPProject › events[43] › payload(0xC0) › Utf16LeString
  cause: EOF reading u16 (remaining: 1 byte)
  previous 16 bytes (hex): 48 00 65 00 6c 00 6c 00 6f 00 00 00 81 02 03 04
```

### Strict-mode bonus checks (cheap)

From day one, the custom schemas also validate:

- `VarIntSchema`: shift > 35 → corruption (bounded by 32-bit length)
- `FLPEventSchema`: declared payload length fits in remaining buffer
- `Utf16LeStringSchema`: emits a warning through the nesting path if
  the terminator is missing before payload end (not an error — some FL
  versions emit unterminated strings; we want visibility, not hard fail)

All are single comparisons with no hot-path cost. They turn obscure
EOF errors at the wrong level into directly actionable messages.

### Hex-dump context on fatal errors

When `FLPParseError` is constructed, capture the 16 bytes preceding
the failing offset (or the full preceding buffer if < 16 bytes) as a
hex string. This is the single most useful piece of debugging context
when investigating a novel FL version's format changes — and we already
know from Python's dogfooding cycle that novel format changes *will*
happen (FL 25.2 marker byte 12, FL 26 almost certainly something new).

---

## Alternatives considered (2026-04-18)

| Option | Why not |
|---|---|
| **Hand-rolled DataView reader** | Smallest bundle, most predictable. But loses type inference and makes the spec doc less executable. Payload-schema reuse is clunkier. Reconsider if typed-binary ever feels like it's fighting us. |
| **Kaitai Struct** | Genuinely compelling: YAML format description generates parsers for Python/TS/Rust/Go/C++/Java. Lets the clean-room spec be multi-language. But: adds a build step, TS types are loose, niche, and the JS runtime is read-only. File away — if the TS parser ever feels worth porting to a Kaitai DSL for multi-language publish, that's a post-Phase-3.6 conversation. |
| **binary-parser (keichi)** | Mature, popular, `choice()` models TLV nicely. But uses `Function` constructor for codegen (works in most browsers but trips strict CSP), TS integration is weaker than typed-binary, and reads only (no write path). |
| **restructure (foliojs)** | Battle-tested on real binary formats (fontkit, PDFKit). But maintenance has slowed, TS types are loose, bundle is heavier. |

## Open items to confirm during Phase 3.1.2 scaffolding

These don't change the decision but shape the exact implementation:

- [ ] `ISerialInput` — exact API for reading current byte offset. The
      error-annotation helper references it as `currentByteOffset`;
      real API name may differ.
- [ ] Does typed-binary throw structured errors, plain `Error`, or
      something in between? Dictates whether `FLPParseError.cause`
      wrapping needs any special handling.
- [ ] Bundle size with typed-binary fully tree-shaken — target is
      <2 MB gzipped for the browser build (Phase 3 guardrail).
      Expected value: well under, since typed-binary is ~6 KB.
- [ ] Whether `Schema.measure` is reachable without full `write`
      implementations on our custom schemas. Measure is used for
      pre-allocating write buffers; parse-only use may let us stub
      it on the custom classes for now.

Each of these is a 5-minute check during 3.1.2, not a decision.

---

## Update (2026-04-18) — FL 25 override mechanism landed

First Phase 3.1.2 wiring pass revealed a size encoding beyond the
opcode-range-based scheme documented above.

**Discovery.** Opcode `0x36` carries the FL version banner as
UTF-16LE text terminated by a double-null `00 00` at an even offset,
with **no length prefix at all**. The `0x46` byte immediately after
the opcode is the low byte of the first UTF-16 code unit (`F` of
`FL Studio…`), not a size field. Initial hypotheses (varint-prefixed,
then uint16-LE-prefixed) both looked plausible until tempo parsing
refused to align; the actual encoding came from cross-checking the
Python fork's `_fl25_overrides.py` table, which we are allowed to
read for *format facts* (no code copied).

**Design response.** Added a per-opcode size-rule table:

```ts
export type FL25SizeRule = "utf16_zterm";
export const FL25_OVERRIDES: ReadonlyMap<number, FL25SizeRule> =
  new Map<number, FL25SizeRule>([ [0x36, "utf16_zterm"] ]);
```

`FLPEventSchema.read()` consults this table before falling back to
the opcode-range rule. The three custom schemas
(`VarIntSchema`, `Utf16LeStringSchema`, `FLPEventSchema`) are still
the primitives; the override map is the per-opcode data-driven policy
that `FLPEventSchema` uses to pick a length-encoding strategy.

Future overrides (e.g., additional FL-25-specific opcodes discovered
via RE sweeps) extend this map by adding a `SizeRule` variant and a
branch in `FLPEventSchema.read()`. The format-spec doc (Phase 3.1.3)
will host the canonical catalog of what each overridden opcode
means semantically.

**Tempo smoke test is green** on `base_empty.flp`: version banner
`"FL Studio 25.2.4.4960.4960"`, PPQ 96, tempo 120 BPM (opcode 0x9C,
stored as `bpm × 1000 = 120000` uint32 LE) — all match Python's
`flp-info` output.

## Cross-references

- `docs/fl-format/flp-format-spec.md` — clean-room FLP format spec
- `docs/fl-format/fl25-event-format.md` — FL 25-specific event-format observations
