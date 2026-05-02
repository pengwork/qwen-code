/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExpertManager,
  activateExpert,
  aggregateAll,
  appendRating,
  buildSubagentConfig,
  deactivateExpert,
  getActiveExpertName,
  parseRatingLabel,
} from '@qwen-code/qwen-code-core';
import type {
  CommandContext,
  ExecutionMode,
  MessageActionReturn,
  SlashCommand,
  SlashCommandActionReturn,
  SubmitPromptActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

const SUPPORTED_MODES: ExecutionMode[] = ['interactive'];

/**
 * Returns the project-rooted ExpertManager for the current context, or
 * `null` if no project root is available (e.g. invoked before config load).
 */
function getManager(context: CommandContext): ExpertManager | null {
  const root = context.services.config?.getProjectRoot();
  if (!root) return null;
  return new ExpertManager(root);
}

function fail(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'error', content };
}

function info(content: string): MessageActionReturn {
  return { type: 'message', messageType: 'info', content };
}

/**
 * Splits an `args` string on whitespace into [first, rest], honoring
 * a single layer of double quotes around the first token.
 */
function takeFirstToken(args: string): [string, string] {
  const trimmed = args.trim();
  if (!trimmed) return ['', ''];
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) {
      return [trimmed.slice(1, end), trimmed.slice(end + 1).trim()];
    }
  }
  const space = trimmed.search(/\s/);
  if (space < 0) return [trimmed, ''];
  return [trimmed.slice(0, space), trimmed.slice(space + 1).trim()];
}

function tokenize(args: string, count: number): string[] {
  const out: string[] = [];
  let rest = args.trim();
  for (let i = 0; i < count - 1; i++) {
    const [first, remainder] = takeFirstToken(rest);
    if (!first) {
      out.push('');
      rest = '';
      continue;
    }
    out.push(first);
    rest = remainder;
  }
  out.push(rest);
  return out;
}

const newSubcommand: SlashCommand = {
  name: 'new',
  get description() {
    return 'Create a new virtual expert and (optionally) push to a git remote.';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    const [name, rest] = takeFirstToken(args);
    const [maybeUrl, maybeDescRest] = takeFirstToken(rest);
    if (!name || !maybeUrl) {
      return fail('Usage: /expert new <name> <git-url> [description]');
    }
    const description = (maybeDescRest || `Virtual expert "${name}"`).trim();
    try {
      const expert = await mgr.newExpert(name, description, maybeUrl);
      return info(
        `Created expert "${expert.name}" at ${expert.rootDir}\n` +
          `Pushed initial commit to ${maybeUrl}.\n` +
          `Add knowledge with: /expert add ${expert.name} <title> :: <body>`,
      );
    } catch (err) {
      return fail(`Failed to create expert: ${errMsg(err)}`);
    }
  },
};

const getSubcommand: SlashCommand = {
  name: 'get',
  get description() {
    return 'Clone an existing virtual expert from a git URL.';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    // Accept "get <url>" and "get <url> as <name>".
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return fail('Usage: /expert get <git-url> [as <name>]');
    }
    const url = tokens[0];
    let asName: string | undefined;
    if (tokens.length >= 3 && tokens[1].toLowerCase() === 'as') {
      asName = tokens[2];
    } else if (tokens.length === 2) {
      asName = tokens[1];
    }
    try {
      const expert = await mgr.getExpertFromRemote(url, asName);
      return info(
        `Imported expert "${expert.name}" with ${expert.chunks.length} chunk(s).`,
      );
    } catch (err) {
      return fail(`Failed to get expert: ${errMsg(err)}`);
    }
  },
};

const addSubcommand: SlashCommand = {
  name: 'add',
  get description() {
    return 'Add a knowledge chunk to an expert.';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  argumentHint: '<name> <title> :: <body>',
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    const [name, rest] = takeFirstToken(args);
    if (!name || !rest) {
      return fail('Usage: /expert add <name> <title> :: <body>');
    }
    const sepIdx = rest.indexOf('::');
    if (sepIdx < 0) {
      return fail(
        'Usage: /expert add <name> <title> :: <body> ' +
          '(use "::" to separate the title from the body)',
      );
    }
    const title = rest.slice(0, sepIdx).trim();
    const body = rest.slice(sepIdx + 2).trim();
    if (!title || !body) {
      return fail(
        'Both <title> and <body> are required. Usage: /expert add <name> <title> :: <body>',
      );
    }
    try {
      const chunk = await mgr.addChunk(name, title, body);
      return info(
        `Added chunk "${chunk.name}" (id ${chunk.expertChunkId}) to ${name}.`,
      );
    } catch (err) {
      return fail(`Failed to add chunk: ${errMsg(err)}`);
    }
  },
};

const rateSubcommand: SlashCommand = {
  name: 'rate',
  get description() {
    return 'Rate a knowledge chunk: bad | fine | good (or 1/2/3).';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  argumentHint: '<name> <chunkId> <bad|fine|good> [comment]',
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    const [name, chunkId, label, comment] = tokenize(args, 4);
    if (!name || !chunkId || !label) {
      return fail(
        'Usage: /expert rate <name> <chunkId> <bad|fine|good> [comment]',
      );
    }
    const value = parseRatingLabel(label);
    if (value === null) {
      return fail(
        `Invalid rating "${label}". Use one of: bad, fine, good (or 1/2/3).`,
      );
    }
    const rater = process.env['USER'] || process.env['USERNAME'] || 'anon';
    try {
      await appendRating(mgr, name, {
        chunkId,
        rater,
        rating: value,
        comment: comment || undefined,
        ts: new Date().toISOString(),
      });
      return info(`Recorded rating ${label} for chunk ${chunkId}.`);
    } catch (err) {
      return fail(`Failed to rate: ${errMsg(err)}`);
    }
  },
};

const syncSubcommand: SlashCommand = {
  name: 'sync',
  get description() {
    return 'Pull the latest from origin and show what changed.';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  argumentHint: '<name>',
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    const [name] = takeFirstToken(args);
    if (!name) return fail('Usage: /expert sync <name>');
    try {
      const result = await mgr.sync(name);
      if (!result.fetchedNew) {
        return info(`Already up to date for "${name}".`);
      }
      const lines: string[] = [];
      lines.push(
        `Synced "${name}" — ${result.commitMessages.length} new commit(s):`,
      );
      for (const m of result.commitMessages) {
        lines.push(`  • ${m.split('\n')[0]}`);
      }
      const { files, additions, deletions } = result.summary;
      lines.push(
        `Changes: ${files.length} file(s), +${additions}/-${deletions}`,
      );
      for (const f of files.slice(0, 20)) {
        lines.push(`  ${f.path} +${f.additions}/-${f.deletions}`);
      }
      if (files.length > 20) {
        lines.push(`  …and ${files.length - 20} more`);
      }
      return info(lines.join('\n'));
    } catch (err) {
      return fail(`Failed to sync: ${errMsg(err)}`);
    }
  },
};

const useSubcommand: SlashCommand = {
  name: 'use',
  get description() {
    return 'Activate an expert as the current persona for this session.';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  argumentHint: '<name>',
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    const root = context.services.config!.getProjectRoot();
    const [name] = takeFirstToken(args);
    if (!name) return fail('Usage: /expert use <name>');
    try {
      const result = await activateExpert(mgr, root, name);
      const skillsLine = result.registeredSkillNames.length
        ? `\nKnowledge skills now available: ${result.registeredSkillNames.join(', ')}`
        : '\n(No knowledge chunks yet — add some with /expert add ' +
          name +
          ' …)';
      const submit: SubmitPromptActionReturn = {
        type: 'submit_prompt',
        content: [
          {
            text:
              `[System] Adopt the following persona for the rest of this session:\n\n` +
              `${result.subagent.systemPrompt}\n\n` +
              `Acknowledge briefly that you are now ${name} (${result.description}).${skillsLine}`,
          },
        ],
      };
      return submit;
    } catch (err) {
      return fail(`Failed to activate expert: ${errMsg(err)}`);
    }
  },
};

const listSubcommand: SlashCommand = {
  name: 'list',
  get description() {
    return 'List all experts, or show one expert in detail.';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  argumentHint: '[name]',
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const mgr = getManager(context);
    if (!mgr) return fail('Expert command requires an active project.');
    const [name] = takeFirstToken(args);
    try {
      if (!name) {
        const list = await mgr.listExperts();
        if (list.length === 0) {
          return info(
            'No experts in this project. Create one with /expert new.',
          );
        }
        const active = await getActiveExpertName(mgr);
        const lines = list.map((e) => {
          const marker = e.name === active ? ' (active)' : '';
          const commit = e.lastCommit ? ` @${e.lastCommit}` : '';
          return `  ${e.name}${marker} — ${e.chunkCount} chunk(s)${commit}\n      ${e.description}`;
        });
        return info(['Experts:', ...lines].join('\n'));
      }
      const expert = await mgr.loadExpert(name);
      const ratings = await aggregateAll(mgr, name);
      const lines: string[] = [];
      lines.push(`# ${expert.name}`);
      lines.push(expert.manifest.description);
      lines.push('');
      lines.push(`Chunks (${expert.chunks.length}):`);
      for (const c of expert.chunks) {
        const agg = ratings.get(c.expertChunkId);
        const rating =
          agg && agg.count > 0
            ? `[avg ${agg.avg!.toFixed(1)}, n=${agg.count}]`
            : '[unrated]';
        lines.push(`  ${c.expertChunkId}  ${c.name} ${rating}`);
        lines.push(`      ${c.description}`);
      }
      return info(lines.join('\n'));
    } catch (err) {
      return fail(`Failed to list: ${errMsg(err)}`);
    }
  },
};

export const expertCommand: SlashCommand = {
  name: 'expert',
  get description() {
    return 'Build a virtual expert collaboratively (multi-user, git-backed).';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: SUPPORTED_MODES,
  subCommands: [
    newSubcommand,
    getSubcommand,
    addSubcommand,
    rateSubcommand,
    syncSubcommand,
    useSubcommand,
    listSubcommand,
    {
      name: 'unuse',
      get description() {
        return 'Deactivate the current expert (clean up its session skills).';
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: SUPPORTED_MODES,
      action: async (context): Promise<SlashCommandActionReturn | void> => {
        const mgr = getManager(context);
        if (!mgr) return fail('Expert command requires an active project.');
        const root = context.services.config!.getProjectRoot();
        try {
          const { deactivatedName } = await deactivateExpert(mgr, root);
          if (!deactivatedName) {
            return info('No expert is currently active.');
          }
          return info(`Deactivated expert "${deactivatedName}".`);
        } catch (err) {
          return fail(`Failed to deactivate: ${errMsg(err)}`);
        }
      },
    },
  ],
};

// Suppress unused-import lint when the command actually doesn't need
// `buildSubagentConfig` directly — exported for SDK consumers.
void buildSubagentConfig;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
