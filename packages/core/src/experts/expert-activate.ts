/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { SubagentConfig } from '../subagents/types.js';
import type { ExpertManager } from './expert-manager.js';
import { ExpertError, ExpertErrorCode, type LoadedExpert } from './types.js';

const ACTIVE_STATE_FILE = 'active-expert.json';
const EXPERT_SKILL_PREFIX = 'expert-';

interface ActiveState {
  expertName: string;
  registeredSkillNames: string[];
}

export interface ActivationResult {
  /** Session-level SubagentConfig built from expert.md. */
  subagent: SubagentConfig;
  /** Skill names exposed to the SkillManager (with the expert- prefix). */
  registeredSkillNames: string[];
  /** Persona description for the user-facing message. */
  description: string;
}

/**
 * Activate an expert: build a session-level SubagentConfig from its persona,
 * and expose its knowledge chunks to the SkillManager by symlinking their
 * directories into the project's `.qwen/skills/`.
 *
 * If another expert is already active, it is deactivated first.
 */
export async function activateExpert(
  manager: ExpertManager,
  projectRoot: string,
  expertName: string,
): Promise<ActivationResult> {
  // Roll any prior activation back first so symlinks don't pile up.
  await deactivateExpert(manager, projectRoot);

  const expert = await manager.loadExpert(expertName);
  const skillsTargetRoot = path.join(projectRoot, '.qwen', 'skills');
  await fs.mkdir(skillsTargetRoot, { recursive: true });

  const registered: string[] = [];
  for (const chunk of expert.chunks) {
    const exposedName = `${EXPERT_SKILL_PREFIX}${expertName}-${chunk.name}`;
    const target = path.dirname(chunk.filePath); // skill directory
    const linkPath = path.join(skillsTargetRoot, exposedName);
    if (fsSync.existsSync(linkPath)) {
      // Stale leftover from a crash — remove it before linking.
      await safeRemove(linkPath);
    }
    try {
      await fs.symlink(target, linkPath, 'dir');
    } catch (err) {
      // Symlinks can fail on Windows w/o admin or on exotic FS — fall back to copy.
      if (isPermErr(err)) {
        await copyDirRecursive(target, linkPath);
      } else {
        throw new ExpertError(
          `failed to expose chunk skill ${exposedName}: ${errMsg(err)}`,
          ExpertErrorCode.IO_FAILED,
          expertName,
        );
      }
    }
    registered.push(exposedName);
  }

  const state: ActiveState = {
    expertName,
    registeredSkillNames: registered,
  };
  await writeActiveState(manager, state);

  return {
    subagent: buildSubagentConfig(expert),
    registeredSkillNames: registered,
    description: expert.manifest.description,
  };
}

/**
 * Deactivate the currently-active expert: remove all symlinks/copies it
 * registered and clear the active-state marker. Idempotent — silently
 * succeeds when nothing is active.
 */
export async function deactivateExpert(
  manager: ExpertManager,
  projectRoot: string,
): Promise<{ deactivatedName: string | null }> {
  const state = await readActiveState(manager);
  if (!state) {
    return { deactivatedName: null };
  }
  const skillsRoot = path.join(projectRoot, '.qwen', 'skills');
  for (const name of state.registeredSkillNames) {
    await safeRemove(path.join(skillsRoot, name));
  }
  await clearActiveState(manager);
  return { deactivatedName: state.expertName };
}

/**
 * Read the currently-active expert name, if any.
 */
export async function getActiveExpertName(
  manager: ExpertManager,
): Promise<string | null> {
  const state = await readActiveState(manager);
  return state?.expertName ?? null;
}

/**
 * Build a session-level SubagentConfig from a loaded expert. The systemPrompt
 * is the persona body plus a short index of the available knowledge skills,
 * so the agent knows what it can pull in on demand.
 */
export function buildSubagentConfig(expert: LoadedExpert): SubagentConfig {
  const m = expert.manifest;
  const personaBody = m.systemPrompt.trim();
  const skillIndex = expert.chunks.length
    ? '\n\n## Available knowledge skills\n' +
      expert.chunks
        .map(
          (c) =>
            `- \`${EXPERT_SKILL_PREFIX}${expert.name}-${c.name}\`: ${c.description}`,
        )
        .join('\n')
    : '';
  const config: SubagentConfig = {
    name: m.name,
    description: m.description,
    systemPrompt: `${personaBody}${skillIndex}\n`,
    level: 'session',
  };
  if (m.tools) config.tools = m.tools;
  if (m.approvalMode) config.approvalMode = m.approvalMode;
  if (m.model) config.model = m.model;
  if (m.color) config.color = m.color;
  return config;
}

// ── internals ────────────────────────────────────────────────────────────

async function readActiveState(
  manager: ExpertManager,
): Promise<ActiveState | null> {
  const filePath = path.join(manager.rootDir(), ACTIVE_STATE_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ActiveState;
    if (
      typeof parsed.expertName === 'string' &&
      Array.isArray(parsed.registeredSkillNames)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeActiveState(
  manager: ExpertManager,
  state: ActiveState,
): Promise<void> {
  await fs.mkdir(manager.rootDir(), { recursive: true });
  await fs.writeFile(
    path.join(manager.rootDir(), ACTIVE_STATE_FILE),
    JSON.stringify(state, null, 2),
    'utf8',
  );
}

async function clearActiveState(manager: ExpertManager): Promise<void> {
  const filePath = path.join(manager.rootDir(), ACTIVE_STATE_FILE);
  try {
    await fs.unlink(filePath);
  } catch {
    // already gone — fine
  }
}

async function safeRemove(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || stat.isFile()) {
      await fs.unlink(target);
    } else if (stat.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    }
  } catch {
    // not present — fine
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

function isPermErr(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
