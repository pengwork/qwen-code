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
import { ExpertManager } from './expert-manager.js';
import {
  activateExpert,
  buildSubagentConfig,
  deactivateExpert,
  getActiveExpertName,
} from './expert-activate.js';

describe('buildSubagentConfig', () => {
  it('emits a session-level SubagentConfig with persona + chunk index', async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'expert-build-'),
    );
    try {
      const mgr = new ExpertManager(projectRoot);
      await mgr.newExpert('pg-tuning', 'PG perf tuner');
      await mgr.addChunk('pg-tuning', 'VACUUM tuning', 'body');
      await mgr.addChunk('pg-tuning', 'INDEX choice', 'body');
      const expert = await mgr.loadExpert('pg-tuning');
      const config = buildSubagentConfig(expert);
      expect(config.level).toBe('session');
      expect(config.name).toBe('pg-tuning');
      expect(config.description).toBe('PG perf tuner');
      expect(config.systemPrompt).toContain('## Available knowledge skills');
      expect(config.systemPrompt).toContain('expert-pg-tuning-vacuum-tuning');
      expect(config.systemPrompt).toContain('expert-pg-tuning-index-choice');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('omits the chunk index when there are no chunks', async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'expert-build-'),
    );
    try {
      const mgr = new ExpertManager(projectRoot);
      await mgr.newExpert('pg-tuning', 'PG');
      const expert = await mgr.loadExpert('pg-tuning');
      const config = buildSubagentConfig(expert);
      expect(config.systemPrompt).not.toContain('Available knowledge skills');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('activateExpert / deactivateExpert', () => {
  let projectRoot: string;
  let mgr: ExpertManager;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-act-'));
    mgr = new ExpertManager(projectRoot);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('exposes each chunk under .qwen/skills/ with an expert- prefix', async () => {
    await mgr.newExpert('pg-tuning', 'PG');
    await mgr.addChunk('pg-tuning', 'VACUUM tuning', 'body');
    await mgr.addChunk('pg-tuning', 'INDEX choice', 'body2');

    const result = await activateExpert(mgr, projectRoot, 'pg-tuning');
    expect(result.registeredSkillNames.sort()).toEqual([
      'expert-pg-tuning-index-choice',
      'expert-pg-tuning-vacuum-tuning',
    ]);

    for (const name of result.registeredSkillNames) {
      const linkPath = path.join(projectRoot, '.qwen', 'skills', name);
      expect(fsSync.existsSync(linkPath)).toBe(true);
      // Resolves to a directory containing SKILL.md
      const skillMd = path.join(linkPath, 'SKILL.md');
      expect(fsSync.existsSync(skillMd)).toBe(true);
    }
  });

  it('records the active expert and clears it on deactivation', async () => {
    await mgr.newExpert('pg-tuning', 'PG');
    await mgr.addChunk('pg-tuning', 'VACUUM tuning', 'body');

    expect(await getActiveExpertName(mgr)).toBeNull();
    await activateExpert(mgr, projectRoot, 'pg-tuning');
    expect(await getActiveExpertName(mgr)).toBe('pg-tuning');

    const { deactivatedName } = await deactivateExpert(mgr, projectRoot);
    expect(deactivatedName).toBe('pg-tuning');
    expect(await getActiveExpertName(mgr)).toBeNull();

    // Symlink is gone
    expect(
      fsSync.existsSync(
        path.join(
          projectRoot,
          '.qwen',
          'skills',
          'expert-pg-tuning-vacuum-tuning',
        ),
      ),
    ).toBe(false);
  });

  it('replaces the active expert when activate is called again', async () => {
    await mgr.newExpert('pg-tuning', 'PG');
    await mgr.addChunk('pg-tuning', 'VACUUM', 'body');
    await mgr.newExpert('redis-tuning', 'Redis');
    await mgr.addChunk('redis-tuning', 'maxmemory', 'body');

    await activateExpert(mgr, projectRoot, 'pg-tuning');
    await activateExpert(mgr, projectRoot, 'redis-tuning');

    expect(await getActiveExpertName(mgr)).toBe('redis-tuning');
    // pg-tuning chunk's symlink should be gone
    expect(
      fsSync.existsSync(
        path.join(projectRoot, '.qwen', 'skills', 'expert-pg-tuning-vacuum'),
      ),
    ).toBe(false);
    // redis-tuning chunk's symlink should be present
    expect(
      fsSync.existsSync(
        path.join(
          projectRoot,
          '.qwen',
          'skills',
          'expert-redis-tuning-maxmemory',
        ),
      ),
    ).toBe(true);
  });

  it('deactivate is a no-op when no expert is active', async () => {
    const { deactivatedName } = await deactivateExpert(mgr, projectRoot);
    expect(deactivatedName).toBeNull();
  });
});
