/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  ExpertManager,
  getExpertDir,
  makeChunkId,
  parseChunkFile,
  parseExpertManifest,
  serializeChunk,
  serializeExpertManifest,
  slugifyTitle,
  validateExpertName,
} from './expert-manager.js';
import { ExpertError } from './types.js';

describe('expert-manager helpers', () => {
  it('validateExpertName accepts safe names and rejects unsafe ones', () => {
    expect(() => validateExpertName('pg-tuning')).not.toThrow();
    expect(() => validateExpertName('PG_Tuning.v2')).not.toThrow();
    expect(() => validateExpertName('foo/bar')).toThrow(ExpertError);
    expect(() => validateExpertName('..')).toThrow(ExpertError);
    expect(() => validateExpertName('')).toThrow(ExpertError);
  });

  it('slugifyTitle produces filesystem-safe slugs', () => {
    expect(slugifyTitle('VACUUM tuning for high-churn tables')).toBe(
      'vacuum-tuning-for-high-churn-tables',
    );
    expect(slugifyTitle('   Hello, World!   ')).toBe('hello-world');
    expect(slugifyTitle('////')).toMatch(/^chunk-[0-9a-f]+$/);
  });

  it('makeChunkId is deterministic given the same inputs', () => {
    const a = makeChunkId('vacuum-tuning', '2026-05-01T00:00:00Z');
    const b = makeChunkId('vacuum-tuning', '2026-05-01T00:00:00Z');
    const c = makeChunkId('vacuum-tuning', '2026-05-02T00:00:00Z');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^chunk_[0-9a-f]{10}$/);
  });

  it('serializeExpertManifest round-trips through parseExpertManifest', () => {
    const manifest = {
      name: 'pg-tuning',
      description: 'PostgreSQL performance tuning specialist',
      systemPrompt: 'You are a PG expert.\n\nBe concise.',
      tools: ['shell'],
      approvalMode: 'default',
    };
    const serialized = serializeExpertManifest(manifest);
    const parsed = parseExpertManifest(serialized, '/fake/expert.md');
    expect(parsed.name).toBe(manifest.name);
    expect(parsed.description).toBe(manifest.description);
    expect(parsed.systemPrompt).toBe(manifest.systemPrompt);
    expect(parsed.tools).toEqual(manifest.tools);
    expect(parsed.approvalMode).toBe(manifest.approvalMode);
  });

  it('serializeChunk round-trips through parseChunkFile', () => {
    const chunk = {
      expertChunkId: 'chunk_abc1234567',
      name: 'vacuum-tuning',
      description: 'VACUUM for high-churn tables',
      author: 'alice',
      createdAt: '2026-05-01T00:00:00.000Z',
      body: 'Run VACUUM ANALYZE often.',
      filePath: '/fake/SKILL.md',
    };
    const serialized = serializeChunk(chunk);
    const parsed = parseChunkFile(serialized, chunk.filePath);
    expect(parsed.expertChunkId).toBe(chunk.expertChunkId);
    expect(parsed.name).toBe(chunk.name);
    expect(parsed.description).toBe(chunk.description);
    expect(parsed.author).toBe(chunk.author);
    expect(parsed.createdAt).toBe(chunk.createdAt);
    expect(parsed.body).toBe(chunk.body);
  });
});

describe('ExpertManager (filesystem)', () => {
  let projectRoot: string;
  let bareRemote: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-proj-'));
    bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-remote-'));
    await simpleGit(bareRemote).init(['--bare', '--initial-branch=main']);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(bareRemote, { recursive: true, force: true });
  });

  it('newExpert scaffolds dir, expert.md, ratings.jsonl, and a git repo', async () => {
    const mgr = new ExpertManager(projectRoot);
    const remoteUrl = 'file://' + bareRemote;
    const loaded = await mgr.newExpert('pg-tuning', 'PG perf tuner', remoteUrl);

    expect(loaded.name).toBe('pg-tuning');
    expect(loaded.manifest.description).toBe('PG perf tuner');
    expect(loaded.chunks).toEqual([]);

    const dir = getExpertDir(projectRoot, 'pg-tuning');
    expect(fsSync.existsSync(path.join(dir, 'expert.md'))).toBe(true);
    expect(fsSync.existsSync(path.join(dir, 'ratings.jsonl'))).toBe(true);
    expect(fsSync.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(fsSync.existsSync(path.join(dir, 'skills'))).toBe(true);

    // Remote received the initial commit
    const log = await simpleGit(bareRemote).log(['main']);
    expect(log.total).toBe(1);
  });

  it('newExpert refuses to overwrite an existing expert', async () => {
    const mgr = new ExpertManager(projectRoot);
    await mgr.newExpert('pg-tuning', 'first');
    await expect(mgr.newExpert('pg-tuning', 'again')).rejects.toThrow(
      /already exists/i,
    );
  });

  it('addChunk creates skills/<slug>/SKILL.md and pushes to origin', async () => {
    const mgr = new ExpertManager(projectRoot);
    const remoteUrl = 'file://' + bareRemote;
    await mgr.newExpert('pg-tuning', 'PG perf tuner', remoteUrl);
    const chunk = await mgr.addChunk(
      'pg-tuning',
      'VACUUM tuning',
      'Run VACUUM regularly.',
      'alice',
    );
    expect(chunk.name).toBe('vacuum-tuning');
    expect(chunk.expertChunkId).toMatch(/^chunk_/);
    expect(fsSync.existsSync(chunk.filePath)).toBe(true);

    const remoteLog = await simpleGit(bareRemote).log(['main']);
    expect(remoteLog.total).toBeGreaterThanOrEqual(2);
    expect(remoteLog.latest?.message).toMatch(/add chunk "VACUUM tuning"/);
  });

  it('addChunk uniques slugs when titles collide', async () => {
    const mgr = new ExpertManager(projectRoot);
    await mgr.newExpert('pg-tuning', 'PG');
    const a = await mgr.addChunk('pg-tuning', 'Same Title', 'a');
    const b = await mgr.addChunk('pg-tuning', 'Same Title', 'b');
    expect(a.name).toBe('same-title');
    expect(b.name).toBe('same-title-2');
  });

  it('listExperts reports each expert with chunk count and last-commit hash', async () => {
    const mgr = new ExpertManager(projectRoot);
    await mgr.newExpert('pg-tuning', 'PG');
    await mgr.newExpert('redis-tuning', 'Redis');
    await mgr.addChunk('pg-tuning', 'first', 'body-a');
    await mgr.addChunk('pg-tuning', 'second', 'body-b');

    const list = await mgr.listExperts();
    expect(list.map((e) => e.name)).toEqual(['pg-tuning', 'redis-tuning']);
    const pg = list.find((e) => e.name === 'pg-tuning')!;
    expect(pg.chunkCount).toBe(2);
    expect(pg.lastCommit).toMatch(/^[0-9a-f]{7}$/);
    expect(pg.description).toBe('PG');
  });

  it('loadExpert returns persona body and all chunks sorted by createdAt', async () => {
    const mgr = new ExpertManager(projectRoot);
    await mgr.newExpert('pg-tuning', 'PG');
    await mgr.addChunk('pg-tuning', 'first', 'a');
    await mgr.addChunk('pg-tuning', 'second', 'b');

    const loaded = await mgr.loadExpert('pg-tuning');
    expect(loaded.manifest.systemPrompt).toContain('You are pg-tuning');
    expect(loaded.chunks.map((c) => c.description)).toEqual([
      'first',
      'second',
    ]);
  });

  it('appendHostGitignore adds the experts marker exactly once', async () => {
    const giPath = path.join(projectRoot, '.gitignore');
    await fs.writeFile(giPath, 'node_modules\n', 'utf8');
    const mgr = new ExpertManager(projectRoot);
    await mgr.newExpert('a', 'a');
    await mgr.newExpert('b', 'b');
    const final = await fs.readFile(giPath, 'utf8');
    const matches = final
      .split('\n')
      .filter((line) => line.trim() === '.qwen/experts/');
    expect(matches.length).toBe(1);
  });

  it('getExpertFromRemote clones an expert created elsewhere', async () => {
    const remoteUrl = 'file://' + bareRemote;
    // Author publishes
    const authorRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'expert-author-'),
    );
    try {
      const author = new ExpertManager(authorRoot);
      await author.newExpert('pg-tuning', 'PG perf tuner', remoteUrl);
      await author.addChunk('pg-tuning', 'VACUUM', 'body');

      // Consumer pulls
      const consumer = new ExpertManager(projectRoot);
      const loaded = await consumer.getExpertFromRemote(remoteUrl);
      expect(loaded.name).toBe(path.basename(bareRemote));
      expect(loaded.chunks.length).toBe(1);
    } finally {
      await fs.rm(authorRoot, { recursive: true, force: true });
    }
  });

  it('sync pulls new commits and reports a non-empty diff summary', async () => {
    const remoteUrl = 'file://' + bareRemote;
    const authorRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'expert-author-'),
    );
    try {
      // Initial publish from author
      const author = new ExpertManager(authorRoot);
      await author.newExpert('pg-tuning', 'PG', remoteUrl);

      // Consumer clones
      const consumer = new ExpertManager(projectRoot);
      await consumer.getExpertFromRemote(remoteUrl, 'pg-tuning');

      // Author adds knowledge and pushes
      await author.addChunk('pg-tuning', 'VACUUM tuning', 'body');

      // Consumer syncs
      const result = await consumer.sync('pg-tuning');
      expect(result.fetchedNew).toBe(true);
      expect(result.summary.files.length).toBeGreaterThan(0);
      expect(result.commitMessages.some((m) => m.includes('add chunk'))).toBe(
        true,
      );
    } finally {
      await fs.rm(authorRoot, { recursive: true, force: true });
    }
  });
});
