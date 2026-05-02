/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExpertManager } from './expert-manager.js';
import {
  aggregateAll,
  aggregateForChunk,
  appendRating,
  loadRatings,
  parseRatingLabel,
} from './expert-ratings.js';

describe('parseRatingLabel', () => {
  it('accepts the three label words', () => {
    expect(parseRatingLabel('bad')).toBe(1);
    expect(parseRatingLabel('FINE')).toBe(2);
    expect(parseRatingLabel(' Good ')).toBe(3);
  });

  it('accepts numeric strings 1/2/3', () => {
    expect(parseRatingLabel('1')).toBe(1);
    expect(parseRatingLabel('3')).toBe(3);
  });

  it('rejects anything else', () => {
    expect(parseRatingLabel('great')).toBeNull();
    expect(parseRatingLabel('0')).toBeNull();
    expect(parseRatingLabel('')).toBeNull();
  });
});

describe('expert-ratings', () => {
  let projectRoot: string;
  let mgr: ExpertManager;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-ratings-'));
    mgr = new ExpertManager(projectRoot);
    await mgr.newExpert('pg-tuning', 'PG');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('appendRating writes a JSON line and loadRatings reads it back', async () => {
    const chunk = await mgr.addChunk('pg-tuning', 'VACUUM', 'body');
    await appendRating(mgr, 'pg-tuning', {
      chunkId: chunk.expertChunkId,
      rater: 'alice',
      rating: 3,
      comment: 'great',
      ts: '2026-05-01T00:00:00.000Z',
    });
    const all = await loadRatings(mgr, 'pg-tuning');
    expect(all.length).toBe(1);
    expect(all[0].rater).toBe('alice');
    expect(all[0].rating).toBe(3);
  });

  it('aggregateForChunk computes count and mean', async () => {
    const chunk = await mgr.addChunk('pg-tuning', 'VACUUM', 'body');
    const ratings = [1, 2, 3] as const;
    for (let i = 0; i < ratings.length; i++) {
      await appendRating(mgr, 'pg-tuning', {
        chunkId: chunk.expertChunkId,
        rater: `r${i}`,
        rating: ratings[i],
        ts: new Date(2026, 4, i + 1).toISOString(),
      });
    }
    const agg = await aggregateForChunk(mgr, 'pg-tuning', chunk.expertChunkId);
    expect(agg.count).toBe(3);
    expect(agg.avg).toBe(2);
    expect(agg.comments.length).toBe(3);
  });

  it('aggregateForChunk returns count=0 / avg=null when there are no ratings', async () => {
    const chunk = await mgr.addChunk('pg-tuning', 'VACUUM', 'body');
    const agg = await aggregateForChunk(mgr, 'pg-tuning', chunk.expertChunkId);
    expect(agg.count).toBe(0);
    expect(agg.avg).toBeNull();
  });

  it('loadRatings tolerates malformed JSON lines', async () => {
    const chunk = await mgr.addChunk('pg-tuning', 'VACUUM', 'body');
    await appendRating(mgr, 'pg-tuning', {
      chunkId: chunk.expertChunkId,
      rater: 'alice',
      rating: 3,
      ts: '2026-05-01T00:00:00.000Z',
    });
    const ratingsPath = path.join(mgr.expertDir('pg-tuning'), 'ratings.jsonl');
    await fs.appendFile(ratingsPath, 'this is not json\n', 'utf8');
    const all = await loadRatings(mgr, 'pg-tuning');
    expect(all.length).toBe(1);
  });

  it('aggregateAll groups ratings across chunks', async () => {
    const a = await mgr.addChunk('pg-tuning', 'first', 'body');
    const b = await mgr.addChunk('pg-tuning', 'second', 'body');
    await appendRating(mgr, 'pg-tuning', {
      chunkId: a.expertChunkId,
      rater: 'alice',
      rating: 3,
      ts: '2026-05-01T00:00:00.000Z',
    });
    await appendRating(mgr, 'pg-tuning', {
      chunkId: b.expertChunkId,
      rater: 'alice',
      rating: 1,
      ts: '2026-05-01T00:00:01.000Z',
    });
    const map = await aggregateAll(mgr, 'pg-tuning');
    expect(map.size).toBe(2);
    expect(map.get(a.expertChunkId)?.avg).toBe(3);
    expect(map.get(b.expertChunkId)?.avg).toBe(1);
  });
});
