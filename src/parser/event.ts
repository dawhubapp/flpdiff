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
 * encoding. Each entry maps the opcode to how its payload is delimited.
 *
 *   byte3 — fixed 3-byte payload (no size prefix). Captured as a blob
 *           since the semantic content is not yet decoded.
 *
 * Currently known:
 *   0xAC — byte3. Falls in the 0x80-0xBF "4-byte payload" range under
 *          the classic rule, but actually carries 3 bytes. Treating it
 *          as 4 bytes consumes the next event's opcode byte, which on
 *          FL 25 happens to be 0xC0 (the version banner). The misparse
 *          coincidentally aligns because the version banner's varint
 *          length byte (0x36) was historically misread as a separate
 *          opcode with a UTF-16-zero-terminated payload — both
 *          interpretations consume the same byte range, but the
 *          opcode/event identity was wrong. See issue #1 for the
 *          discovery and `docs/fl-format/fl25-event-format.md` for
 *          evidence.
 */
export type FL25SizeRule = "byte3";

export const FL25_OVERRIDES: ReadonlyMap<number, FL25SizeRule> = new Map<number, FL25SizeRule>([
  [0xac, "byte3"],
]);

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
          if (override === "byte3") {
            return { kind: "blob", opcode, payload: readBytes(input, 3) };
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
        if (override === "byte3") {
          if (value.payload.byteLength !== 3) {
            throw new Error(
              `byte3 opcode 0x${value.opcode.toString(16)} expects 3-byte payload, got ${value.payload.byteLength}`,
            );
          }
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
        if (override === "byte3") {
          return measurer.add(1 + 3);
        }
        const m = varInt.measure(ev.payload.byteLength, measurer);
        return m.add(1 + ev.payload.byteLength);
      }
    }
  }
}

export const flpEvent: FLPEventSchema = new FLPEventSchema();
