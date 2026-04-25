import { BufferReader } from "typed-binary";
import type { ISerialInput } from "typed-binary";
import { annotateRead, FLPParseError } from "./errors.ts";
import { flpEvent, type FLPEvent } from "./event.ts";
import { decodeUtf16LeBytes } from "./primitives.ts";
import { buildChannels, buildMixerInserts, buildPatterns, buildArrangements } from "./project-builder.ts";
import type { Channel } from "../model/channel.ts";
import type { MixerInsert } from "../model/mixer-insert.ts";
import type { Pattern } from "../model/pattern.ts";
import type { Arrangement } from "../model/arrangement.ts";

/**
 * FLP file header parsed from "FLhd" + "FLdt" blocks.
 *
 * The format field historically tracked (0=none, 1=song, ...); modern FL
 * always writes 0. n_channels is legacy and does not reflect the project's
 * real channel count — channels come from the event stream.
 */
export type FLPHeader = {
  format: number;
  n_channels: number;
  ppq: number;
};

export type FLPProject = {
  header: FLPHeader;
  events: FLPEvent[];
  channels: Channel[];
  inserts: MixerInsert[];
  patterns: Pattern[];
  arrangements: Arrangement[];
};

const FLHD_MAGIC = [0x46, 0x4c, 0x68, 0x64]; // "FLhd"
const FLDT_MAGIC = [0x46, 0x4c, 0x64, 0x74]; // "FLdt"

function readMagic(input: ISerialInput, expected: number[], label: string): void {
  annotateRead(label, input, { pathFragment: label }, () => {
    for (let i = 0; i < expected.length; i++) {
      const b = input.readUint8();
      if (b !== expected[i]) {
        throw new Error(
          `magic mismatch: expected byte 0x${expected[i]!.toString(16).padStart(2, "0")} at position ${i}, got 0x${b.toString(16).padStart(2, "0")}`,
        );
      }
    }
  });
}

function readHeader(input: ISerialInput): FLPHeader {
  return annotateRead("FLPHeader", input, { pathFragment: "FLhd" }, () => {
    const headerLen = input.readUint32();
    if (headerLen !== 6) {
      throw new Error(`unexpected FLhd length ${headerLen}, expected 6`);
    }
    const format = input.readUint16();
    const n_channels = input.readUint16();
    const ppq = input.readUint16();
    return { format, n_channels, ppq };
  });
}

/**
 * Parse an FLP file from a buffer. Returns the raw header + event list.
 * Higher-level model assembly (channels, patterns, tracks, plugins) is
 * a separate pass not yet implemented.
 */
export function parseFLPFile(buffer: ArrayBufferLike): FLPProject {
  const input = new BufferReader(buffer, { endianness: "little" });
  return annotateRead("FLPProject", input, { pathFragment: "FLPProject" }, () => {
    readMagic(input, FLHD_MAGIC, "FLhd");
    const header = readHeader(input);

    readMagic(input, FLDT_MAGIC, "FLdt");
    const dataLen = input.readUint32();
    const dataEnd = input.currentByteOffset + dataLen;

    const events: FLPEvent[] = [];
    let eventIndex = 0;
    while (input.currentByteOffset < dataEnd) {
      const idx = eventIndex++;
      try {
        const ev = flpEvent.read(input);
        events.push(ev);
      } catch (e) {
        if (e instanceof FLPParseError) {
          throw e.extend({ eventIndex: idx, nestingPath: [`events[${idx}]`] });
        }
        throw e;
      }
    }

    const channels = buildChannels(events);
    const inserts = buildMixerInserts(events);
    const patterns = buildPatterns(events);
    const arrangements = buildArrangements(events, channels, patterns);
    return { header, events, channels, inserts, patterns, arrangements };
  });
}

/**
 * Pick the FL Studio version banner carried in opcode 0x36 (FL 25+).
 *
 * Opcode 0x36 is one of the FL25 range-rule overrides — treated as a
 * varint-prefixed blob despite falling in the 0x00-0x3F "1-byte payload"
 * range. Payload is UTF-16LE, null-terminated, typically of the form
 * "L Studio Producer Edition v25.2.4" (note the leading 'F' of
 * "FL Studio" is coincidentally consumed by the length byte in a
 * minimal project, per docs/fl25-event-format.md).
 *
 * Returns undefined for pre-FL-25 files, which do not emit opcode 0x36.
 */
export function getFLVersionBanner(project: FLPProject): string | undefined {
  const ev = project.events.find((e) => e.kind === "blob" && e.opcode === 0x36);
  if (!ev || ev.kind !== "blob") return undefined;
  return decodeUtf16LeBytes(ev.payload);
}

/**
 * Convenience: pick tempo from the event stream.
 *
 * FL Studio has used three opcodes for tempo across versions:
 *
 * | Opcode | Role             | Encoding           | First seen     |
 * |--------|------------------|--------------------|----------------|
 * | 0x9C   | Tempo (modern)   | uint32 milli-BPM   | FL 3.4.0+      |
 * | 0x42   | Tempo coarse     | uint16 integer BPM | pre-FL-3.4.0   |
 * | 0x5D   | Tempo fine       | uint16 milli-BPM   | FL 3.4.0+      |
 *
 * Modern files emit 0x9C. Legacy FL 9/11 files that pre-date the
 * unified Tempo opcode rely on 0x42 (+ optional 0x5D for decimals).
 * Walks modern → coarse → fine.
 */
export function getTempo(project: FLPProject): number | undefined {
  const modern = project.events.find((e) => e.kind === "u32" && e.opcode === 0x9c);
  if (modern && modern.kind === "u32") return modern.value / 1000;

  const coarse = project.events.find((e) => e.kind === "u16" && e.opcode === 0x42);
  if (!coarse || coarse.kind !== "u16") return undefined;
  let tempo = coarse.value;
  const fine = project.events.find((e) => e.kind === "u16" && e.opcode === 0x5d);
  if (fine && fine.kind === "u16") tempo += fine.value / 1000;
  return tempo;
}
