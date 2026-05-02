/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import type { Config } from '@qwen-code/qwen-code-core';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext, SlashCommand } from './types.js';
import { expertCommand } from './expertCommand.js';

function findSub(name: string): SlashCommand {
  const sub = expertCommand.subCommands?.find((s) => s.name === name);
  if (!sub) throw new Error(`Subcommand "${name}" not found`);
  return sub;
}

async function runSub(
  name: string,
  args: string,
  context: CommandContext,
): Promise<{ type: string; messageType?: string; content?: string }> {
  const sub = findSub(name);
  const result = await sub.action!(context, args);
  if (!result) throw new Error(`Subcommand ${name} returned void`);
  // Narrow for the common message return shape.
  const out = result as {
    type: string;
    messageType?: string;
    content?: string;
  };
  return out;
}

describe('expertCommand', () => {
  let projectRoot: string;
  let bareRemote: string;
  let context: CommandContext;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-cmd-'));
    bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-cmd-remote-'));
    await simpleGit(bareRemote).init(['--bare', '--initial-branch=main']);
    context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => projectRoot,
        } as unknown as Config,
      },
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(bareRemote, { recursive: true, force: true });
  });

  it('exposes the expected subcommands', () => {
    const names = (expertCommand.subCommands ?? []).map((s) => s.name).sort();
    expect(names).toEqual([
      'add',
      'get',
      'list',
      'new',
      'rate',
      'sync',
      'unuse',
      'use',
    ]);
  });

  it('new + list together create and report an expert', async () => {
    const remoteUrl = 'file://' + bareRemote;
    const created = await runSub(
      'new',
      `pg-tuning ${remoteUrl} PG perf tuner`,
      context,
    );
    expect(created.messageType).toBe('info');
    expect(created.content).toContain('Created expert "pg-tuning"');

    const listed = await runSub('list', '', context);
    expect(listed.messageType).toBe('info');
    expect(listed.content).toContain('pg-tuning');
    expect(listed.content).toContain('0 chunk(s)');
  });

  it('add rejects missing "::" separator with a usage error', async () => {
    const remoteUrl = 'file://' + bareRemote;
    await runSub('new', `pg-tuning ${remoteUrl}`, context);
    const result = await runSub('add', 'pg-tuning No separator here', context);
    expect(result.messageType).toBe('error');
    expect(result.content).toMatch(/use "::"/);
  });

  it('add records a chunk and list shows it with [unrated]', async () => {
    const remoteUrl = 'file://' + bareRemote;
    await runSub('new', `pg-tuning ${remoteUrl}`, context);
    const added = await runSub(
      'add',
      'pg-tuning VACUUM tuning :: Run VACUUM regularly.',
      context,
    );
    expect(added.messageType).toBe('info');

    const listed = await runSub('list', 'pg-tuning', context);
    expect(listed.content).toMatch(
      /chunk_[0-9a-f]+ {2}vacuum-tuning \[unrated\]/,
    );
  });

  it('rate updates the aggregate visible in list', async () => {
    const remoteUrl = 'file://' + bareRemote;
    await runSub('new', `pg-tuning ${remoteUrl}`, context);
    await runSub(
      'add',
      'pg-tuning VACUUM tuning :: Run VACUUM regularly.',
      context,
    );
    const detail = await runSub('list', 'pg-tuning', context);
    const m = detail.content!.match(/chunk_[0-9a-f]+/);
    expect(m).not.toBeNull();
    const chunkId = m![0];

    const rated = await runSub(
      'rate',
      `pg-tuning ${chunkId} good Solid advice`,
      context,
    );
    expect(rated.messageType).toBe('info');

    const after = await runSub('list', 'pg-tuning', context);
    expect(after.content).toMatch(/avg 3.0, n=1/);
  });

  it('rate rejects an unknown rating label', async () => {
    const remoteUrl = 'file://' + bareRemote;
    await runSub('new', `pg-tuning ${remoteUrl}`, context);
    await runSub('add', 'pg-tuning A :: B', context);
    const result = await runSub(
      'rate',
      'pg-tuning chunk_xxxx great whatever',
      context,
    );
    expect(result.messageType).toBe('error');
    expect(result.content).toMatch(/Invalid rating/);
  });

  it('use returns a submit_prompt with the persona text', async () => {
    const remoteUrl = 'file://' + bareRemote;
    await runSub('new', `pg-tuning ${remoteUrl} PG perf tuner`, context);
    await runSub('add', 'pg-tuning VACUUM :: body', context);
    const sub = findSub('use');
    const result = await sub.action!(context, 'pg-tuning');
    if (!result || (result as { type: string }).type !== 'submit_prompt') {
      throw new Error('expected submit_prompt return');
    }
    const text = (result as { content: Array<{ text: string }> }).content[0]
      .text;
    expect(text).toContain('Adopt the following persona');
    expect(text).toContain('You are pg-tuning');
    expect(text).toContain('Knowledge skills now available');
  });

  it('get clones an expert pushed by another user', async () => {
    const remoteUrl = 'file://' + bareRemote;
    // Author publishes from a separate project root
    const authorRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'expert-cmd-auth-'),
    );
    const authorContext = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => authorRoot,
        } as unknown as Config,
      },
    });
    try {
      await runSub('new', `pg-tuning ${remoteUrl} PG`, authorContext);
      await runSub('add', 'pg-tuning A :: a', authorContext);

      const got = await runSub('get', `${remoteUrl} as pg-tuning`, context);
      expect(got.messageType).toBe('info');
      expect(got.content).toMatch(/Imported expert "pg-tuning" with 1 chunk/);
    } finally {
      await fs.rm(authorRoot, { recursive: true, force: true });
    }
  });

  it('sync reports new commits and a non-empty change summary', async () => {
    const remoteUrl = 'file://' + bareRemote;
    const authorRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'expert-cmd-auth-'),
    );
    const authorContext = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => authorRoot,
        } as unknown as Config,
      },
    });
    try {
      await runSub('new', `pg-tuning ${remoteUrl} PG`, authorContext);
      await runSub('get', `${remoteUrl} as pg-tuning`, context);
      await runSub('add', 'pg-tuning VACUUM :: body', authorContext);
      const synced = await runSub('sync', 'pg-tuning', context);
      expect(synced.content).toContain('1 new commit');
      expect(synced.content).toMatch(/add chunk "VACUUM"/);
    } finally {
      await fs.rm(authorRoot, { recursive: true, force: true });
    }
  });
});
