/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExpertManager } from './expert-manager.js';
import {
  ExpertError,
  ExpertErrorCode,
  type Rating,
  type RatingAggregate,
} from './types.js';

const RATINGS_FILE = 'ratings.jsonl';

/** Numeric values for the {bad, fine, good} labels — same as UserFeedbackRating. */
export const RATING_VALUES = {
  bad: 1,
  fine: 2,
  good: 3,
} as const;
export type RatingLabel = keyof typeof RATING_VALUES;

/**
 * Parses a free-form label into a rating value, or returns null if invalid.
 */
export function parseRatingLabel(input: string): 1 | 2 | 3 | null {
  const v = input.trim().toLowerCase();
  if (v in RATING_VALUES) {
    return RATING_VALUES[v as RatingLabel];
  }
  // Allow numeric input too.
  if (v === '1' || v === '2' || v === '3') {
    return Number(v) as 1 | 2 | 3;
  }
  return null;
}

/**
 * Append a single rating line to `ratings.jsonl` and (best-effort) push.
 * Append-only: changing your mind = appending a new line.
 */
export async function appendRating(
  manager: ExpertManager,
  expertName: string,
  rating: Rating,
): Promise<void> {
  const dir = manager.expertDir(expertName);
  const ratingsPath = path.join(dir, RATINGS_FILE);
  // Make sure the file exists; new experts have an empty one but cloned
  // experts may have it but we still tolerate either.
  try {
    await fs.access(ratingsPath);
  } catch {
    throw new ExpertError(
      `ratings.jsonl missing in ${dir} — is this expert initialised?`,
      ExpertErrorCode.IO_FAILED,
      expertName,
    );
  }
  await fs.appendFile(ratingsPath, JSON.stringify(rating) + '\n', 'utf8');
  await manager.commitAndPush(dir, `rate ${rating.chunkId} ${rating.rating}`);
}

/**
 * Load all ratings for an expert. Malformed lines are silently skipped
 * (demo posture: tolerate hand-edited files).
 */
export async function loadRatings(
  manager: ExpertManager,
  expertName: string,
): Promise<Rating[]> {
  const dir = manager.expertDir(expertName);
  const ratingsPath = path.join(dir, RATINGS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(ratingsPath, 'utf8');
  } catch {
    return [];
  }
  const out: Rating[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Rating;
      if (
        typeof parsed.chunkId === 'string' &&
        typeof parsed.rater === 'string' &&
        (parsed.rating === 1 || parsed.rating === 2 || parsed.rating === 3) &&
        typeof parsed.ts === 'string'
      ) {
        out.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Aggregate ratings for one chunk: count + mean + raw comments.
 */
export async function aggregateForChunk(
  manager: ExpertManager,
  expertName: string,
  chunkId: string,
): Promise<RatingAggregate> {
  const ratings = await loadRatings(manager, expertName);
  const matching = ratings.filter((r) => r.chunkId === chunkId);
  if (matching.length === 0) {
    return { chunkId, count: 0, avg: null, comments: [] };
  }
  const sum = matching.reduce((acc, r) => acc + r.rating, 0);
  return {
    chunkId,
    count: matching.length,
    avg: sum / matching.length,
    comments: matching.map((r) => ({
      rater: r.rater,
      rating: r.rating,
      comment: r.comment,
      ts: r.ts,
    })),
  };
}

/**
 * Aggregate ratings for every chunk that's been rated. Useful for `/expert list <name>`.
 */
export async function aggregateAll(
  manager: ExpertManager,
  expertName: string,
): Promise<Map<string, RatingAggregate>> {
  const ratings = await loadRatings(manager, expertName);
  const byChunk = new Map<string, Rating[]>();
  for (const r of ratings) {
    const arr = byChunk.get(r.chunkId) ?? [];
    arr.push(r);
    byChunk.set(r.chunkId, arr);
  }
  const result = new Map<string, RatingAggregate>();
  for (const [chunkId, list] of byChunk) {
    const sum = list.reduce((acc, r) => acc + r.rating, 0);
    result.set(chunkId, {
      chunkId,
      count: list.length,
      avg: sum / list.length,
      comments: list.map((r) => ({
        rater: r.rater,
        rating: r.rating,
        comment: r.comment,
        ts: r.ts,
      })),
    });
  }
  return result;
}
