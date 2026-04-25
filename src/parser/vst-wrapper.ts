/**
 * VST-wrapper blob decoder — parses the inner id-length-value record
 * stream that FL puts inside `0xD5` plugin-state payloads for
 * VST-hosted plugins.
 *
 * Blob layout (verified on `base_one_serum.flp`'s Serum instance):
 *
 *   0..3      uint32 LE `type` — first byte is the FL serialization
 *             marker (6/8/9/10/11/12 observed for FL 9..25; not used
 *             for parsing, only for sanity checks).
 *   4..       repeating records until end of blob:
 *               4 bytes:  record id      (uint32 LE)
 *               8 bytes:  record length  (uint64 LE)
 *               N bytes:  record data
 *
 * Record-id catalog (format facts, verified by byte inspection on
 * the Serum instance):
 *
 *    1 MIDI          struct (input/output/pb_range + extras)
 *    2 Flags         struct
 *   30 IO
 *   31 Inputs
 *   32 Outputs
 *   50 PluginInfo
 *   51 FourCC        UTF-8 4-char VST ID
 *   52 GUID          16-byte VST3 plugin GUID
 *   53 State         plugin-specific preset/session blob (opaque)
 *   54 Name          UTF-8 VST display name — THE FIELD WE WANT
 *   55 PluginPath    UTF-8 DLL/VST3 path on disk
 *   56 Vendor        UTF-8 vendor name — ALSO WANTED
 *
 * For a native FL plugin, `0xD5` is NOT this record stream — it's
 * plugin-specific state. This decoder is intended to be called ONLY
 * when the owning entity's `internalName` is `"Fruity Wrapper"`
 * (FL's generic VST host class); callers must gate on that.
 */

const VST_EVENT_ID_NAME = 54;
const VST_EVENT_ID_VENDOR = 56;
const VST_EVENT_ID_PLUGIN_PATH = 55;
const VST_EVENT_ID_FOURCC = 51;

const RECORD_HEADER_BYTES = 12; // 4-byte id + 8-byte length

export type VSTWrapperInfo = {
  /** UTF-8 VST display name (e.g. `"Serum"`). Absent if the Name record is missing. */
  name?: string;
  /** UTF-8 vendor string (e.g. `"Xfer Records"`). */
  vendor?: string;
  /** Path to the DLL / VST3 bundle on the user's machine. */
  pluginPath?: string;
  /** Four-character VST identifier (e.g. `"XfrX"` for Serum). Absent for VST3 and Waveshell. */
  fourCC?: string;
  /** First byte of the `type` header — the FL serialization marker. */
  marker?: number;
};

const UTF8 = new TextDecoder("utf-8", { fatal: false });

/**
 * Parse a VST-wrapper payload, extracting name / vendor / plugin path.
 * Returns an empty-ish object if the payload doesn't match the
 * record-stream shape (e.g. it's a native-plugin state blob).
 *
 * Intentionally defensive: malformed records are skipped, never throw.
 * A single corrupt record shouldn't torpedo the whole channel walk.
 */
export function decodeVSTWrapper(payload: Uint8Array): VSTWrapperInfo {
  const info: VSTWrapperInfo = {};
  if (payload.byteLength < 4) return info;

  info.marker = payload[0];

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let pos = 4;

  while (pos + RECORD_HEADER_BYTES <= payload.byteLength) {
    const id = view.getUint32(pos, true);
    const len64 = view.getBigUint64(pos + 4, true);
    // Sanity clamp: any record claiming to be larger than the remaining
    // payload indicates either corruption or a non-wrapper blob.
    if (len64 > BigInt(payload.byteLength - pos - RECORD_HEADER_BYTES)) {
      // Stop parsing rather than over-reading. Whatever we've already
      // extracted is kept.
      break;
    }
    const len = Number(len64);
    const dataStart = pos + RECORD_HEADER_BYTES;
    const data = payload.subarray(dataStart, dataStart + len);

    switch (id) {
      case VST_EVENT_ID_NAME:
        info.name = UTF8.decode(data);
        break;
      case VST_EVENT_ID_VENDOR:
        info.vendor = UTF8.decode(data);
        break;
      case VST_EVENT_ID_PLUGIN_PATH:
        info.pluginPath = UTF8.decode(data);
        break;
      case VST_EVENT_ID_FOURCC:
        info.fourCC = UTF8.decode(data);
        break;
      // Unknown / uninteresting ids are skipped silently.
    }

    pos = dataStart + len;
  }

  return info;
}
