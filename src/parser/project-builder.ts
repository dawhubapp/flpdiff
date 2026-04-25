import type { FLPEvent } from "./event.ts";
import { type Channel, classifyChannelKind } from "../model/channel.ts";

/**
 * Opcode constants for the entity-boundary events. Each is a format fact
 * cross-referenced against the dev repo's `docs/fl25-event-format.md`
 * and the clean-room spec at `ts/docs/flp-format-spec.md`; naming here is
 * our own (not borrowed from the reference parser).
 */
const OP_NEW_CHANNEL = 0x40;
const OP_CHANNEL_TYPE = 0x15;

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

  for (const ev of events) {
    if (ev.opcode === OP_NEW_CHANNEL && ev.kind === "u16") {
      current = { iid: ev.value, kind: "unknown" };
      channels.push(current);
      continue;
    }
    if (ev.opcode === OP_CHANNEL_TYPE && ev.kind === "u8" && current) {
      current.kind = classifyChannelKind(ev.value);
      continue;
    }
  }

  return channels;
}
