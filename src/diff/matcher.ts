/**
 * Entity matching across two `FLPProject` instances.
 *
 * Pairs channels, patterns, mixer inserts, tracks, and arrangements
 * between an "old" and "new" project so the comparator can diff
 * matched pairs and label the rest as additions or removals.
 *
 * Strategy (mirrors Python's `flp_diff.matcher`):
 *
 * 1. **Primary key match.** Pair entities whose stable identity key
 *    is equal — channel `iid`, pattern `id`, mixer insert `index`,
 *    track `index`, arrangement `id`. Confidence: `"exact"`.
 * 2. **Secondary name match.** For entities left over after pass 1,
 *    try to pair by a name-based key (with type guard where
 *    appropriate — e.g. a sampler and an instrument named "Lead" do
 *    NOT pair). Confidence: `"name"`.
 * 3. **Anything still unpaired** becomes a one-sided Match with
 *    confidence `"unmatched"` — `old === null` means added,
 *    `new === null` means removed.
 *
 * Returned match lists are deterministic: all exact matches in the
 * order `old` presents them, then name matches in old-order, then
 * removals (in old-order), then additions (in new-order).
 */

import type { Channel } from "../model/channel.ts";
import type { Pattern } from "../model/pattern.ts";
import type { MixerInsert } from "../model/mixer-insert.ts";
import type { Arrangement, Track } from "../model/arrangement.ts";
import type { FLPProject } from "../parser/flp-project.ts";

export type MatchConfidence = "exact" | "name" | "unmatched";

/**
 * One pairing decision. Exactly one of these three shapes holds:
 *
 * - `old !== null && new !== null` → matched pair (confidence "exact" or "name")
 * - `old !== null && new === null` → removed (confidence "unmatched")
 * - `old === null && new !== null` → added (confidence "unmatched")
 */
export type Match<T> = {
  old: T | null;
  new: T | null;
  confidence: MatchConfidence;
};

export function isMatched<T>(m: Match<T>): m is { old: T; new: T; confidence: MatchConfidence } {
  return m.old !== null && m.new !== null;
}

export function isAdded<T>(m: Match<T>): m is { old: null; new: T; confidence: "unmatched" } {
  return m.old === null && m.new !== null;
}

export function isRemoved<T>(m: Match<T>): m is { old: T; new: null; confidence: "unmatched" } {
  return m.old !== null && m.new === null;
}

/**
 * Two-pass pairing workhorse. `primaryKey` must be unique within each
 * side (FL entity identity keys are). `secondaryKey` may return
 * `undefined` to opt an entity out of name matching.
 *
 * Keys are compared via a JSON-serialised stringification so compound
 * keys like `[kind, name]` tuples work naturally (Python uses
 * `Hashable`; TS has no built-in equivalent for arrays).
 */
function pairByKey<T>(
  a: readonly T[],
  b: readonly T[],
  primaryKey: (x: T) => string | number,
  secondaryKey?: (x: T) => string | undefined,
): Match<T>[] {
  const matches: Match<T>[] = [];
  const bPrimaryIdx = new Map<string | number, number>();
  for (let i = 0; i < b.length; i++) {
    const k = primaryKey(b[i]!);
    if (!bPrimaryIdx.has(k)) bPrimaryIdx.set(k, i);
  }
  const consumedB = new Set<number>();

  // Pass 1: primary key
  let unmatchedA: T[] = [];
  for (const x of a) {
    const k = primaryKey(x);
    const idx = bPrimaryIdx.get(k);
    if (idx !== undefined && !consumedB.has(idx)) {
      matches.push({ old: x, new: b[idx]!, confidence: "exact" });
      consumedB.add(idx);
    } else {
      unmatchedA.push(x);
    }
  }

  // Pass 2: secondary key (name-based, optional)
  if (secondaryKey !== undefined) {
    const stillUnmatchedA: T[] = [];
    for (const x of unmatchedA) {
      const sk = secondaryKey(x);
      if (sk === undefined) {
        stillUnmatchedA.push(x);
        continue;
      }
      let found: number | undefined;
      for (let i = 0; i < b.length; i++) {
        if (consumedB.has(i)) continue;
        if (secondaryKey(b[i]!) === sk) {
          found = i;
          break;
        }
      }
      if (found !== undefined) {
        matches.push({ old: x, new: b[found]!, confidence: "name" });
        consumedB.add(found);
      } else {
        stillUnmatchedA.push(x);
      }
    }
    unmatchedA = stillUnmatchedA;
  }

  // Removed (in A, not paired)
  for (const x of unmatchedA) {
    matches.push({ old: x, new: null, confidence: "unmatched" });
  }

  // Added (in B, not paired)
  for (let i = 0; i < b.length; i++) {
    if (!consumedB.has(i)) {
      matches.push({ old: null, new: b[i]!, confidence: "unmatched" });
    }
  }

  return matches;
}

// --------------------------------------------------------------------- //
// Typed wrappers — one per canonical entity                             //
// --------------------------------------------------------------------- //

/**
 * Pair channels by `iid` (exact), falling back to `(kind, name)`.
 *
 * The `kind` guard prevents a sampler "Lead" and an instrument "Lead"
 * from being paired — those represent fundamentally different channels
 * despite sharing a name. Mirrors Python's `match_channels`.
 */
export function matchChannels(
  oldChannels: readonly Channel[],
  newChannels: readonly Channel[],
): Match<Channel>[] {
  return pairByKey(
    oldChannels,
    newChannels,
    (c) => c.iid,
    (c) => (c.name ? `${c.kind}\x00${c.name}` : undefined),
  );
}

/** Pair patterns by `id` (exact), falling back to `name`. */
export function matchPatterns(
  oldPatterns: readonly Pattern[],
  newPatterns: readonly Pattern[],
): Match<Pattern>[] {
  return pairByKey(
    oldPatterns,
    newPatterns,
    (p) => p.id,
    (p) => p.name || undefined,
  );
}

/**
 * Pair mixer inserts by `index` (exact), falling back to `name`.
 * Mixer insert index is structural (Master=0, etc.) so exact matching
 * handles the near-total majority of real diffs. Name fallback catches
 * reordering inside FL.
 */
export function matchMixerInserts(
  oldInserts: readonly MixerInsert[],
  newInserts: readonly MixerInsert[],
): Match<MixerInsert>[] {
  return pairByKey(
    oldInserts,
    newInserts,
    (i) => i.index,
    (i) => i.name || undefined,
  );
}

/** Pair tracks (inside one arrangement) by `index`, falling back to `name`. */
export function matchTracks(
  oldTracks: readonly Track[],
  newTracks: readonly Track[],
): Match<Track>[] {
  return pairByKey(
    oldTracks,
    newTracks,
    (t) => t.index,
    (t) => t.name || undefined,
  );
}

/**
 * Pair arrangements by `id` (exact), falling back to `name`. Most FL
 * projects have one arrangement; the matcher still handles the multi-
 * arrangement case so a rename surfaces as a single "modified"
 * instead of "removed + added".
 */
export function matchArrangements(
  oldArrangements: readonly Arrangement[],
  newArrangements: readonly Arrangement[],
): Match<Arrangement>[] {
  return pairByKey(
    oldArrangements,
    newArrangements,
    (a) => a.id,
    (a) => a.name || undefined,
  );
}

// --------------------------------------------------------------------- //
// Full project matching                                                 //
// --------------------------------------------------------------------- //

export type ProjectMatch = {
  channels: Match<Channel>[];
  patterns: Match<Pattern>[];
  mixerInserts: Match<MixerInsert>[];
  arrangements: Match<Arrangement>[];
};

/** Run every per-entity matcher on two FLPProjects. */
export function matchProjects(oldProj: FLPProject, newProj: FLPProject): ProjectMatch {
  return {
    channels: matchChannels(oldProj.channels, newProj.channels),
    patterns: matchPatterns(oldProj.patterns, newProj.patterns),
    mixerInserts: matchMixerInserts(oldProj.inserts, newProj.inserts),
    arrangements: matchArrangements(oldProj.arrangements, newProj.arrangements),
  };
}
