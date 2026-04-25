import { Schema, MaxValue } from "typed-binary";
import type { ISerialInput, ISerialOutput, IMeasurer } from "typed-binary";
import { Measurer } from "typed-binary";
import { annotateRead } from "./errors.ts";

/**
 * 7-bit varint used to prefix payload length for FLP opcodes in 0xC0-0xFF.
 * Each byte contributes 7 bits; high bit set means "more bytes follow".
 */
export class VarIntSchema extends Schema<number> {
  read(input: ISerialInput): number {
    return annotateRead("VarInt", input, {}, () => {
      let value = 0;
      let shift = 0;
      let byte: number;
      do {
        if (shift > 35) {
          throw new Error("varint exceeds 5 bytes (> 2^35) — corrupt");
        }
        byte = input.readUint8();
        value |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      return value >>> 0;
    });
  }

  write(output: ISerialOutput, value: number): void {
    let v = value >>> 0;
    while (v >= 0x80) {
      output.writeUint8((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    output.writeUint8(v & 0x7f);
  }

  measure(value: number | typeof MaxValue, measurer: IMeasurer = new Measurer()): IMeasurer {
    if (value === MaxValue) return measurer.add(5);
    let v = (value as number) >>> 0;
    let bytes = 1;
    while (v >= 0x80) {
      bytes++;
      v >>>= 7;
    }
    return measurer.add(bytes);
  }
}

export const varInt: VarIntSchema = new VarIntSchema();

/**
 * UTF-16LE null-terminated string. FL stores plugin names, track names,
 * sample paths etc. this way inside variable-length event payloads.
 *
 * Uses TextDecoder with fatal=false to tolerate unpaired surrogates that
 * real FL projects emit — we want parse tolerance, not strict Unicode.
 */
export class Utf16LeStringSchema extends Schema<string> {
  private static _decoder: TextDecoder | undefined;
  private static get decoder(): TextDecoder {
    if (!Utf16LeStringSchema._decoder) {
      Utf16LeStringSchema._decoder = new TextDecoder("utf-16le" as "utf-8", { fatal: false });
    }
    return Utf16LeStringSchema._decoder;
  }

  read(input: ISerialInput): string {
    return annotateRead("Utf16LeString", input, {}, () => {
      const bytes: number[] = [];
      while (true) {
        const lo = input.readUint8();
        const hi = input.readUint8();
        if (lo === 0 && hi === 0) break;
        bytes.push(lo, hi);
      }
      return Utf16LeStringSchema.decoder.decode(new Uint8Array(bytes));
    });
  }

  write(output: ISerialOutput, value: string): void {
    for (const codeUnit of this.toUtf16CodeUnits(value)) {
      output.writeUint8(codeUnit & 0xff);
      output.writeUint8((codeUnit >> 8) & 0xff);
    }
    output.writeUint8(0);
    output.writeUint8(0);
  }

  measure(value: string | typeof MaxValue, measurer: IMeasurer = new Measurer()): IMeasurer {
    if (value === MaxValue) return measurer.unbounded;
    const codeUnits = this.toUtf16CodeUnits(value as string);
    return measurer.add(codeUnits.length * 2 + 2);
  }

  private toUtf16CodeUnits(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      out.push(s.charCodeAt(i));
    }
    return out;
  }
}

export const utf16LeString: Utf16LeStringSchema = new Utf16LeStringSchema();

/**
 * UTF-8 null-terminated string. Used by a small number of newer opcodes
 * (e.g. 0x36 FL25 version string) that carry ASCII/UTF-8 payloads instead
 * of the usual UTF-16.
 */
export class Utf8NullTermStringSchema extends Schema<string> {
  private static _decoder: TextDecoder | undefined;
  private static get decoder(): TextDecoder {
    if (!Utf8NullTermStringSchema._decoder) {
      Utf8NullTermStringSchema._decoder = new TextDecoder("utf-8", { fatal: false });
    }
    return Utf8NullTermStringSchema._decoder;
  }

  read(input: ISerialInput): string {
    return annotateRead("Utf8NullTermString", input, {}, () => {
      const bytes: number[] = [];
      while (true) {
        const b = input.readUint8();
        if (b === 0) break;
        bytes.push(b);
      }
      return Utf8NullTermStringSchema.decoder.decode(new Uint8Array(bytes));
    });
  }

  write(output: ISerialOutput, value: string): void {
    const encoded = new TextEncoder().encode(value);
    for (const b of encoded) output.writeUint8(b);
    output.writeUint8(0);
  }

  measure(value: string | typeof MaxValue, measurer: IMeasurer = new Measurer()): IMeasurer {
    if (value === MaxValue) return measurer.unbounded;
    return measurer.add(new TextEncoder().encode(value as string).length + 1);
  }
}

export const utf8NullTermString: Utf8NullTermStringSchema = new Utf8NullTermStringSchema();

/**
 * Decode a payload slice (from an FLPEvent) as a UTF-16LE null-terminated
 * string. The event stream already captured the raw bytes; this is a
 * second-pass helper for event handlers.
 */
export function decodeUtf16LeBytes(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder("utf-16le" as "utf-8", { fatal: false }).decode(bytes.subarray(0, end));
}

/**
 * Decode a payload slice as a UTF-8 null-terminated string.
 */
export function decodeUtf8Bytes(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end));
}
