import { BufferReader } from "typed-binary";
import type { ISerialInput } from "typed-binary";
import { annotateRead, FLPParseError } from "./errors.ts";
import { flpEvent, type FLPEvent } from "./event.ts";
import { decodeUtf16LeBytes } from "./primitives.ts";
import { buildChannels, buildMixerInserts, buildPatterns, buildArrangements, buildMetadata, collectInsertRouting } from "./project-builder.ts";
import type { Channel } from "../model/channel.ts";
import type { MixerInsert } from "../model/mixer-insert.ts";
import type { Pattern } from "../model/pattern.ts";
import type { Arrangement } from "../model/arrangement.ts";
import type { ProjectMetadata } from "../model/metadata.ts";

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
  metadata: ProjectMetadata;
  channels: Channel[];
  inserts: MixerInsert[];
  patterns: Pattern[];
  arrangements: Arrangement[];
  /**
   * Project-level routing bit-stream decoded from opcode `0xE7`.
   * FL emits a small number of these events (often just one) — a
   * dense byte array where each byte is a boolean flag.
   *
   * This is **not** a per-insert matrix. The bits pair with
   * MixerParams records whose id ≥ 64 (RouteVolStart): for each
   * such record the next flag from the stream says whether that
   * route is active. We keep the raw byte order here so a future
   * per-insert projection can reproduce the same pairing.
   *
   * Kept as TS-internal enrichment only — Python's `flp-info` JSON
   * emits `routes_to: []` for every insert (a known limitation of
   * the reference adapter). Our presentation layer matches that
   * empty list so Pass 2 parity stays green.
   */
  insertRouting: boolean[];
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

    const metadata = buildMetadata(events);
    const channels = buildChannels(events, metadata);
    const inserts = buildMixerInserts(events, metadata);
    const patterns = buildPatterns(events, metadata);
    const arrangements = buildArrangements(events, channels, patterns, metadata);
    const insertRouting = collectInsertRouting(events);
    return { header, events, metadata, channels, inserts, patterns, arrangements, insertRouting };
  });
}

/**
 * Pick the FL Studio version banner carried in opcode 0xC0 (FL 25+).
 *
 * 0xC0 is the canonical TEXT/DATA range start (varint-prefixed payload).
 * In FL 25 minimal saves the first 0xC0 event is a UTF-16LE,
 * null-terminated string of the form "FL Studio 25.2.4.4960.4960\0".
 * Pre-FL-25 files reused 0xC0 for per-channel UTF-16 names; we
 * disambiguate by requiring the decoded string to start with
 * "FL Studio".
 *
 * Returns undefined when no qualifying 0xC0 event exists.
 */
export function getFLVersionBanner(project: FLPProject): string | undefined {
  for (const e of project.events) {
    if (e.kind !== "blob" || e.opcode !== 0xc0) continue;
    const decoded = decodeUtf16LeBytes(e.payload);
    if (decoded.startsWith("FL Studio")) return decoded;
  }
  return undefined;
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
