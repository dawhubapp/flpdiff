import { Schema, MaxValue } from "typed-binary";
import type { ISerialInput, ISerialOutput, IMeasurer } from "typed-binary";
import { Measurer } from "typed-binary";
import { annotateRead } from "./errors.ts";
import { varInt } from "./primitives.ts";

function readBytes(input: ISerialInput, len: number): Uint8Array {
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    payload[i] = input.readUint8();
  }
  return payload;
}

/**
 * One FLP event. The four kinds correspond to the four opcode ranges,
 * each with a different payload-length encoding.
 *
 * The `opcode` is retained on every variant so event-stream consumers can
 * dispatch on it uniformly.
 */
export type FLPEvent =
  | { kind: "u8"; opcode: number; value: number }
  | { kind: "u16"; opcode: number; value: number }
  | { kind: "u32"; opcode: number; value: number }
  | { kind: "blob"; opcode: number; payload: Uint8Array };

/**
 * Size rules for opcodes that deviate from the standard opcode-range
 * encoding in FL Studio 25 and later. Each entry maps the opcode to
 * how its payload is delimited.
 *
 *   utf16_zterm — UTF-16LE text, null-terminated (``00 00`` at an even
 *                 offset), NO size prefix. The payload as captured
 *                 retains the terminator (consumers can strip).
 *
 * Sourced from the format-spec pipeline: empirical byte-inspection of
 * minimal FL 25 base projects. Pre-FL-25 files do not emit these
 * opcodes, so applying the override unconditionally is safe.
 *
 * Currently known:
 *   0x36 — utf16_zterm, the FL version banner. Lives in the 0x00-0x3F
 *          "1-byte payload" range but carries a variable-length string;
 *          the first byte after the opcode is the LOW byte of the
 *          first UTF-16LE code unit (e.g. 0x46 = 'F' of "FL Studio…"),
 *          not a length prefix.
 */
export type FL25SizeRule = "utf16_zterm";

export const FL25_OVERRIDES: ReadonlyMap<number, FL25SizeRule> = new Map<number, FL25SizeRule>([
  [0x36, "utf16_zterm"],
]);

function readUtf16ZTerm(input: ISerialInput): Uint8Array {
  const bytes: number[] = [];
  while (true) {
    const lo = input.readUint8();
    const hi = input.readUint8();
    bytes.push(lo, hi);
    if (lo === 0 && hi === 0) return new Uint8Array(bytes);
  }
}

/**
 * Reads one FLP TLV event. Opcode-range encodes payload length:
 *   0x00-0x3F  → 1-byte payload
 *   0x40-0x7F  → 2-byte payload (uint16 LE)
 *   0x80-0xBF  → 4-byte payload (uint32 LE)
 *   0xC0-0xFF  → varint-prefixed, N-byte payload
 */
export class FLPEventSchema extends Schema<FLPEvent> {
  read(input: ISerialInput): FLPEvent {
    return annotateRead("FLPEvent", input, {}, () => {
      const opcode = input.readUint8();
      return annotateRead(
        "FLPEvent.payload",
        input,
        { opcode, pathFragment: `0x${opcode.toString(16).toUpperCase().padStart(2, "0")}` },
        () => {
          const override = FL25_OVERRIDES.get(opcode);
          if (override === "utf16_zterm") {
            return { kind: "blob", opcode, payload: readUtf16ZTerm(input) };
          }
          if (opcode >= 0xc0) {
            const len = varInt.read(input);
            if (len < 0 || !Number.isFinite(len)) {
              throw new Error(`invalid varint length ${len} for opcode 0x${opcode.toString(16)}`);
            }
            return { kind: "blob", opcode, payload: readBytes(input, len) };
          }
          if (opcode < 0x40) {
            return { kind: "u8", opcode, value: input.readUint8() };
          }
          if (opcode < 0x80) {
            return { kind: "u16", opcode, value: input.readUint16() };
          }
          return { kind: "u32", opcode, value: input.readUint32() };
        },
      );
    });
  }

  write(output: ISerialOutput, value: FLPEvent): void {
    output.writeUint8(value.opcode);
    switch (value.kind) {
      case "u8":
        output.writeUint8(value.value);
        return;
      case "u16":
        output.writeUint16(value.value);
        return;
      case "u32":
        output.writeUint32(value.value);
        return;
      case "blob": {
        const override = FL25_OVERRIDES.get(value.opcode);
        if (override === "utf16_zterm") {
          // Payload captured with trailing 0x00 0x00; write as-is.
          for (const b of value.payload) output.writeUint8(b);
          return;
        }
        varInt.write(output, value.payload.byteLength);
        for (const b of value.payload) output.writeUint8(b);
        return;
      }
    }
  }

  measure(value: FLPEvent | typeof MaxValue, measurer: IMeasurer = new Measurer()): IMeasurer {
    if (value === MaxValue) return measurer.unbounded;
    const ev = value as FLPEvent;
    switch (ev.kind) {
      case "u8":
        return measurer.add(2);
      case "u16":
        return measurer.add(3);
      case "u32":
        return measurer.add(5);
      case "blob": {
        const override = FL25_OVERRIDES.get(ev.opcode);
        if (override === "utf16_zterm") {
          return measurer.add(1 + ev.payload.byteLength);
        }
        const m = varInt.measure(ev.payload.byteLength, measurer);
        return m.add(1 + ev.payload.byteLength);
      }
    }
  }
}

export const flpEvent: FLPEventSchema = new FLPEventSchema();
