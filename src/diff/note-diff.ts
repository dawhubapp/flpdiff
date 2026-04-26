/**
 * Per-note diff inside a pattern — the most musically meaningful
 * layer. Ports `flp_diff.note_diff` exactly, including the three-pass
 * matching strategy and the `describe_position_delta` label grammar.
 *
 * Notes carry no explicit identity key in FL's format, so identity is
 * synthesized from musical attributes:
 *
 *   1. **Exact**: same `(channel_iid, position, key)`. Emits `modified`
 *      if any non-identity field differs, else drops silently.
 *   2. **Moved**: same `(channel_iid, key)` on both sides but position
 *      differs. Greedy nearest-neighbor pairing.
 *   3. **Added / removed**: whatever is left on one side.
 *
 * Output order is deterministic (tests and formatter rely on it):
 * modifieds (old-order) → moves (old-order) → removals (old-order)
 * → additions (new-order).
 *
 * Pitch matching never crosses keys — a note with a different key is
 * a different note, musically. Pitch corrections are rare enough that
 * grouping them under "modified" would hide the common case (layering).
 */

import type { FlpInfoJson } from "../presentation/flp-info.ts";
import { makeNoteChange, type NoteChange } from "./diff-model.ts";

type NoteJson = FlpInfoJson["patterns"][number]["notes"][number];

// --------------------------------------------------------------------- //
// Position quantization                                                 //
// --------------------------------------------------------------------- //

/**
 * Render a position shift in musical units. `ppq` is the project's
 * ticks-per-quarter-note (FL default: 96). One "beat" = a quarter note.
 *
 * Examples for `ppq=96`:
 *   delta_ticks = 96  → "1 beat later"
 *   delta_ticks = -48 → "1/2 beat earlier"
 *   delta_ticks =  12 → "1/8 beat later"
 *   delta_ticks =   6 → "1/16 beat later"
 *   delta_ticks =   3 → "1/32 beat later"
 *   delta_ticks =   7 → "7 ticks later" (no clean subdivision)
 *
 * Mirrors Python's `describe_position_delta` byte-for-byte.
 */
export function describePositionDelta(deltaTicks: number, ppq: number): string {
  if (deltaTicks === 0) return "no move";
  const direction = deltaTicks > 0 ? "later" : "earlier";
  const absTicks = Math.abs(deltaTicks);

  // Whole-beat shift.
  if (absTicks % ppq === 0) {
    const beats = Math.floor(absTicks / ppq);
    return `${beats} beat${beats !== 1 ? "s" : ""} ${direction}`;
  }

  // Fractional subdivisions: 1/2, 1/4, 1/8, 1/16, 1/32, 1/64.
  for (const divisor of [2, 4, 8, 16, 32, 64]) {
    const unitTicks = ppq / divisor;
    if (unitTicks <= 0 || !Number.isInteger(unitTicks)) continue;
    if (absTicks % unitTicks === 0) {
      const count = Math.floor(absTicks / unitTicks);
      if (count === 1) return `1/${divisor} beat ${direction}`;
      return `${count}/${divisor} beat ${direction}`;
    }
  }

  return `${absTicks} tick${absTicks !== 1 ? "s" : ""} ${direction}`;
}

// --------------------------------------------------------------------- //
// Labels                                                                //
// --------------------------------------------------------------------- //

/**
 * MIDI number → scientific pitch notation. Matches Python's
 * `_note_pitch_label`: FL's "middle C" stores MIDI 60 which we render
 * as `"C5"` (FL's UI convention, not the usual C4=60 MIDI convention).
 */
export function notePitchLabel(key: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(key / 12);
  const noteName = names[((key % 12) + 12) % 12]!;
  return `${noteName}${octave}`;
}

/**
 * Short one-line description used inside human labels.
 * `"C5 on channel 1 at beat 3.25"`. Python uses `{:g}` format spec for
 * the beat, which removes trailing zeros and uses shortest representation.
 */
function noteDescription(note: NoteJson, ppq: number): string {
  const beat = note.position / ppq;
  return `${notePitchLabel(note.key)} on channel ${note.channel_iid} at beat ${pythonGFormat(beat)}`;
}

/**
 * Approximate Python's `{:g}` float format: shortest representation
 * without unnecessary trailing zeros or a trailing `.0`. Integer
 * values render bare (`3`), fractional values as natural decimal
 * (`3.25`). Matches Python's output on every case we exercise in
 * note_diff labels.
 */
export function pythonGFormat(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Python's {:g} uses up to 6 significant digits; for our domain
  // (beat positions like 3.25, 62.5, 40.146) the natural JS string
  // is the same or closer. Strip trailing zeros.
  return String(n);
}

// --------------------------------------------------------------------- //
// Core matching algorithm                                               //
// --------------------------------------------------------------------- //

function exactKey(n: NoteJson): string {
  return `${n.channel_iid}\x00${n.position}\x00${n.key}`;
}

function moveKey(n: NoteJson): string {
  return `${n.channel_iid}\x00${n.key}`;
}

function notesFullyEqual(a: NoteJson, b: NoteJson): boolean {
  return (
    a.position === b.position &&
    a.length === b.length &&
    a.key === b.key &&
    a.channel_iid === b.channel_iid &&
    a.pan === b.pan &&
    a.velocity === b.velocity &&
    a.fine_pitch === b.fine_pitch &&
    a.release === b.release
  );
}

/**
 * Produce per-note diff between two note collections for the same
 * pattern. Empty result means note-for-note identical.
 */
export function diffNotes(
  oldNotes: readonly NoteJson[],
  newNotes: readonly NoteJson[],
  ppq: number,
): NoteChange[] {
  const changes: NoteChange[] = [];

  // Pass 1: exact (channel, position, key) match.
  const oldByExact = new Map<string, number[]>();
  for (let i = 0; i < oldNotes.length; i++) {
    const k = exactKey(oldNotes[i]!);
    const bucket = oldByExact.get(k);
    if (bucket) bucket.push(i);
    else oldByExact.set(k, [i]);
  }
  const consumedOld = new Set<number>();
  const consumedNew = new Set<number>();

  const exactMods: NoteChange[] = [];
  for (let j = 0; j < newNotes.length; j++) {
    const newNote = newNotes[j]!;
    const bucket = oldByExact.get(exactKey(newNote));
    if (!bucket) continue;
    let oldIdx: number | undefined;
    for (const idx of bucket) {
      if (!consumedOld.has(idx)) {
        oldIdx = idx;
        break;
      }
    }
    if (oldIdx === undefined) continue;
    consumedOld.add(oldIdx);
    consumedNew.add(j);
    const oldNote = oldNotes[oldIdx]!;
    if (notesFullyEqual(oldNote, newNote)) continue;
    exactMods.push(buildModified(oldNote, newNote, ppq));
  }
  // Preserve old-order for exact modifieds (sort by the original key tuple).
  exactMods.sort((a, b) => {
    const ao = a.oldNote as NoteJson;
    const bo = b.oldNote as NoteJson;
    if (ao.channel_iid !== bo.channel_iid) return ao.channel_iid - bo.channel_iid;
    if (ao.position !== bo.position) return ao.position - bo.position;
    return ao.key - bo.key;
  });
  changes.push(...exactMods);

  // Pass 2: move pairing by (channel, key) on remaining.
  const oldByMove = new Map<string, number[]>();
  for (let i = 0; i < oldNotes.length; i++) {
    if (consumedOld.has(i)) continue;
    const k = moveKey(oldNotes[i]!);
    const bucket = oldByMove.get(k);
    if (bucket) bucket.push(i);
    else oldByMove.set(k, [i]);
  }

  const moveChanges: [number, NoteChange][] = [];
  for (let j = 0; j < newNotes.length; j++) {
    if (consumedNew.has(j)) continue;
    const newNote = newNotes[j]!;
    const bucket = oldByMove.get(moveKey(newNote));
    if (!bucket) continue;

    let bestI: number | undefined;
    let bestDelta: number | undefined;
    for (const i of bucket) {
      if (consumedOld.has(i)) continue;
      const delta = Math.abs(oldNotes[i]!.position - newNote.position);
      if (bestDelta === undefined || delta < bestDelta) {
        bestDelta = delta;
        bestI = i;
      }
    }
    if (bestI === undefined) continue;
    consumedOld.add(bestI);
    consumedNew.add(j);
    moveChanges.push([bestI, buildMoved(oldNotes[bestI]!, newNote, ppq)]);
  }
  moveChanges.sort((a, b) => a[0] - b[0]);
  for (const [, nc] of moveChanges) changes.push(nc);

  // Pass 3: removed / added leftovers.
  for (let i = 0; i < oldNotes.length; i++) {
    if (consumedOld.has(i)) continue;
    const n = oldNotes[i]!;
    changes.push(
      makeNoteChange({
        kind: "removed",
        oldNote: n,
        newNote: null,
        humanLabel: `Removed ${noteDescription(n, ppq)}`,
      }),
    );
  }
  for (let j = 0; j < newNotes.length; j++) {
    if (consumedNew.has(j)) continue;
    const n = newNotes[j]!;
    changes.push(
      makeNoteChange({
        kind: "added",
        oldNote: null,
        newNote: n,
        humanLabel: `Added ${noteDescription(n, ppq)}`,
      }),
    );
  }

  return changes;
}

// --------------------------------------------------------------------- //
// Change builders                                                       //
// --------------------------------------------------------------------- //

function buildModified(oldNote: NoteJson, newNote: NoteJson, ppq: number): NoteChange {
  const parts: string[] = [];

  if (oldNote.velocity !== newNote.velocity) {
    parts.push(`velocity ${oldNote.velocity} → ${newNote.velocity}`);
  }
  if (oldNote.length !== newNote.length) {
    const deltaTicks = newNote.length - oldNote.length;
    let label = `length ${oldNote.length} → ${newNote.length} ticks`;
    // Musical length delta for readability when on a clean subdivision.
    if (Math.abs(deltaTicks) >= Math.floor(ppq / 32)) {
      const musical = describePositionDelta(Math.abs(deltaTicks), ppq);
      const suffix = deltaTicks > 0 ? "longer" : "shorter";
      // describePositionDelta returns "... later"/"earlier"; swap the
      // last token for "longer"/"shorter".
      const lastSpace = musical.lastIndexOf(" ");
      const musicalStem = lastSpace === -1 ? musical : musical.substring(0, lastSpace);
      label = `length ${oldNote.length} → ${newNote.length} ticks (${musicalStem} ${suffix})`;
    }
    parts.push(label);
  }
  if (oldNote.pan !== newNote.pan) {
    parts.push(`pan ${oldNote.pan} → ${newNote.pan}`);
  }
  if (oldNote.release !== newNote.release) {
    parts.push(`release ${oldNote.release} → ${newNote.release}`);
  }
  if (oldNote.fine_pitch !== newNote.fine_pitch) {
    parts.push(`fine pitch ${oldNote.fine_pitch} → ${newNote.fine_pitch}`);
  }

  const detail = parts.length > 0 ? parts.join(", ") : "<unchanged>";
  return makeNoteChange({
    kind: "modified",
    oldNote,
    newNote,
    humanLabel: `${noteDescription(oldNote, ppq)}: ${detail}`,
  });
}

function buildMoved(oldNote: NoteJson, newNote: NoteJson, ppq: number): NoteChange {
  const delta = newNote.position - oldNote.position;
  const shift = describePositionDelta(delta, ppq);
  const extras: string[] = [];
  if (oldNote.velocity !== newNote.velocity) {
    extras.push(`velocity ${oldNote.velocity} → ${newNote.velocity}`);
  }
  if (oldNote.length !== newNote.length) {
    extras.push(`length ${oldNote.length} → ${newNote.length} ticks`);
  }
  const detailSuffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return makeNoteChange({
    kind: "moved",
    oldNote,
    newNote,
    humanLabel: `${notePitchLabel(oldNote.key)} on channel ${oldNote.channel_iid} moved ${shift}${detailSuffix}`,
  });
}
