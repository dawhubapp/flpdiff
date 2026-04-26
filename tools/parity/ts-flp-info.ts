#!/usr/bin/env bun
/**
 * Pass 2 TS snapshot — emit the Python-`flp-info`-equivalent JSON.
 *
 * Uses the presentation layer (`src/presentation/flp-info.ts`) to
 * project the raw `FLPProject` into Python's shape. Runner calls this
 * per-file and deep-compares against `flp-info --format=json`'s output.
 */
import { parseFLPFile, toFlpInfoJson } from "../../src/index.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: ts-flp-info.ts <file.flp>");
  process.exit(2);
}
try {
  const buffer = require("node:fs").readFileSync(path).buffer;
  const project = parseFLPFile(buffer);
  const json = toFlpInfoJson(project);
  process.stdout.write(JSON.stringify(json));
} catch (err) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stdout.write(JSON.stringify({ error: message }));
  process.exit(2);
}
