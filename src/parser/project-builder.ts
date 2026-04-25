import type { FLPEvent } from "./event.ts";
import { decodeUtf16LeBytes } from "./primitives.ts";
import { type Channel, classifyChannelKind } from "../model/channel.ts";

/**
 * Opcode constants for the entity-boundary events. Each is a format fact
 * cross-referenced against the dev repo's `docs/fl25-event-format.md`
 * and the clean-room spec at `ts/docs/flp-format-spec.md`; naming here is
 * our own (not borrowed from the reference parser).
 */
const OP_NEW_CHANNEL = 0x40;
const OP_CHANNEL_TYPE = 0x15;
const OP_CHANNEL_SAMPLE_PATH = 0xc4;
/** Shared name opcode. In a channel scope it's the channel name; in a
 *  mixer-slot scope it's the plugin name. Scope tracked via OP_NEW_SLOT. */
const OP_NAME = 0xcb;
/** Mixer-effect-slot boundary. Each new slot flips the walker's
 *  current-scope to "slot", ending channel attribution for subsequent
 *  0xCB events. */
const OP_NEW_SLOT = 0x62;

/**
 * Walks the event stream and accumulates channels.
 *
 * Channel-boundary rule: opcode 0x40 (WORD, uint16 LE value) announces a
 * new channel with the carried iid. Subsequent events up to the next
 * channel-affecting event belong to that channel. Opcode 0x15 (BYTE)
 * carries the channel-type enum for the *currently active* channel.
 *
 * Everything else in the event stream is ignored at this step — pattern,
 * mixer, and arrangement extraction are separate walkers (Phase 3.3.x).
 */
export function buildChannels(events: readonly FLPEvent[]): Channel[] {
  const channels: Channel[] = [];
  let current: Channel | undefined;
  /**
   * Walker scope. Starts as "outside" (neither channel nor slot). Flips
   * to "channel" on every 0x40 and to "slot" on every 0x62. Only
   * channel-scoped events are attributed to `current`.
   */
  let scope: "outside" | "channel" | "slot" = "outside";

  for (const ev of events) {
    if (ev.opcode === OP_NEW_CHANNEL && ev.kind === "u16") {
      current = { iid: ev.value, kind: "unknown" };
      channels.push(current);
      scope = "channel";
      continue;
    }
    if (ev.opcode === OP_NEW_SLOT) {
      scope = "slot";
      continue;
    }
    if (scope !== "channel" || !current) continue;

    if (ev.opcode === OP_CHANNEL_TYPE && ev.kind === "u8") {
      current.kind = classifyChannelKind(ev.value);
      continue;
    }
    if (ev.opcode === OP_CHANNEL_SAMPLE_PATH && ev.kind === "blob") {
      current.sample_path = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_NAME && ev.kind === "blob" && current.name === undefined) {
      current.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
  }

  return channels;
}
