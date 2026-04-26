/**
 * ANSI colorization for `renderSummary` output. Ports
 * `flp_diff.formatters.text._colorize_line`.
 *
 * Policy: only the leading change marker (`+` / `-` / `~`) at the start
 * of a top-level diff line gets painted. Sub-bullets, section headers,
 * and the summary line stay default — colouring every leaf change
 * makes long diffs read like jelly-bean spew.
 *
 * Pure string → string. TTY / NO_COLOR / `--color` decisions live at
 * the CLI layer; this module doesn't know and doesn't care.
 */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const MARKER_COLOURS: Record<string, string> = {
  "+": GREEN,
  "-": RED,
  "~": YELLOW,
};

const MARKER_INDENTS = new Set([2, 6, 10]);

export function colorizeSummary(body: string): string {
  return body.split("\n").map(colorizeLine).join("\n");
}

function colorizeLine(line: string): string {
  const stripped = line.replace(/^ +/, "");
  const indent = line.length - stripped.length;
  if (!MARKER_INDENTS.has(indent)) return line;
  const marker = stripped[0];
  if (!marker || !(marker in MARKER_COLOURS)) return line;
  if (stripped.length < 2 || stripped[1] !== " ") return line;
  const colour = MARKER_COLOURS[marker]!;
  return `${" ".repeat(indent)}${colour}${marker}${RESET}${stripped.slice(1)}`;
}
