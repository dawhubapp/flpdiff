#!/usr/bin/env bun
/**
 * Emit a minimal structural snapshot of an FLP via the TypeScript parser.
 *
 * Writes JSON to stdout. Shape is stable and matches `py_snapshot.py` —
 * both sides must agree field-for-field for a file to count as "parity".
 *
 * Pass 1 scope: counts and kinds only, no value reconciliation.
 */
import { parseFLPFile, getTempo } from "../../src/index.ts";

type Snapshot = {
  ppq: number;
  tempo: number | null;
  counts: Record<string, number>;
  channel_kinds: Record<string, number>;
};

function snapshot(path: string): Snapshot {
  const buffer = Bun.file(path).arrayBufferSync
    ? Bun.file(path).arrayBufferSync()
    : new Uint8Array(require("node:fs").readFileSync(path)).buffer;
  const project = parseFLPFile(buffer);

  const channel_kinds: Record<string, number> = {};
  for (const ch of project.channels) {
    channel_kinds[ch.kind] = (channel_kinds[ch.kind] ?? 0) + 1;
  }

  const notes_total = project.patterns.reduce(
    (a, p) => a + p.notes.length,
    0,
  );
  const controllers_total = project.patterns.reduce(
    (a, p) => a + p.controllers.length,
    0,
  );
  const named_inserts = project.inserts.filter(
    (i) => i.name !== undefined && i.name.length > 0,
  ).length;
  const filled_slots = project.inserts.reduce(
    (a, ins) => a + ins.slots.filter((s) => s.hasPlugin === true).length,
    0,
  );
  const tracks_total = project.arrangements.reduce(
    (a, arr) => a + arr.tracks.length,
    0,
  );
  const clips_total = project.arrangements.reduce(
    (a, arr) => a + arr.clips.length,
    0,
  );
  const timemarkers_total = project.arrangements.reduce(
    (a, arr) => a + arr.timemarkers.length,
    0,
  );

  const tempo = getTempo(project);
  return {
    ppq: project.header.ppq,
    tempo: tempo === undefined ? null : Math.round(tempo * 1e6) / 1e6,
    counts: {
      arrangements: project.arrangements.length,
      channels: project.channels.length,
      clips_total,
      controllers_total,
      filled_slots,
      inserts: project.inserts.length,
      named_inserts,
      notes_total,
      patterns: project.patterns.length,
      timemarkers_total,
      tracks_total,
    },
    channel_kinds: sorted(channel_kinds),
  };
}

function sorted<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]!;
  return out;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: ts-snapshot.ts <file.flp>");
  process.exit(2);
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

try {
  const snap = snapshot(path);
  process.stdout.write(stableStringify(snap));
} catch (err) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stdout.write(JSON.stringify({ error: message }));
  process.exit(2);
}
