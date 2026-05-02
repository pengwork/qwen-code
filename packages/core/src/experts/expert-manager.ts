/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';
import { initRepositoryWithMainBranch } from '../services/gitInit.js';
import { summarizeUnifiedDiff } from '../agents/arena/diff-summary.js';
import type { ArenaDiffSummary } from '../agents/arena/types.js';
import {
  ExpertError,
  ExpertErrorCode,
  type ExpertListEntry,
  type ExpertManifest,
  type KnowledgeChunk,
  type LoadedExpert,
} from './types.js';

const QWEN_DIR = '.qwen';
const EXPERTS_DIR = 'experts';
const SKILLS_SUBDIR = 'skills';
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Returns the project-level experts root: `<projectRoot>/.qwen/experts/`.
 */
export function getExpertsRootDir(projectRoot: string): string {
  return path.join(projectRoot, QWEN_DIR, EXPERTS_DIR);
}

/**
 * Returns the directory for a single expert.
 */
export function getExpertDir(projectRoot: string, name: string): string {
  return path.join(getExpertsRootDir(projectRoot), name);
}

/**
 * Throws ExpertError if the name is unsafe to use as a directory.
 */
export function validateExpertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new ExpertError(
      `Invalid expert name: "${name}". Allowed: letters, digits, "_", ".", "-".`,
      ExpertErrorCode.INVALID_NAME,
      name,
    );
  }
}

/**
 * Turns a free-form chunk title into a filesystem-safe slug.
 * Falls back to a short hash if the title is empty after sanitisation.
 */
export function slugifyTitle(title: string): string {
  const cleaned = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned) {
    return cleaned.slice(0, 60);
  }
  return 'chunk-' + shortHash(title + Date.now());
}

/**
 * Stable id for a chunk. Salted with createdAt so re-uploads of a same-titled
 * chunk get a fresh id.
 */
export function makeChunkId(name: string, createdAt: string): string {
  return 'chunk_' + shortHash(`${name}|${createdAt}`);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

/**
 * Parses an expert.md file (YAML frontmatter + body).
 * The format is identical to a SubAgent .md file.
 */
export function parseExpertManifest(
  content: string,
  filePath: string,
): ExpertManifest {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new ExpertError(
      `Missing YAML frontmatter in ${filePath}`,
      ExpertErrorCode.INVALID_MANIFEST,
    );
  }
  const [, fm, body] = match;
  const frontmatter = parseYaml(fm) as Record<string, unknown>;
  const name = String(frontmatter['name'] ?? '');
  const description = String(frontmatter['description'] ?? '');
  if (!name || !description) {
    throw new ExpertError(
      `expert.md must define "name" and "description" (${filePath})`,
      ExpertErrorCode.INVALID_MANIFEST,
    );
  }
  const tools = Array.isArray(frontmatter['tools'])
    ? (frontmatter['tools'] as unknown[]).map(String)
    : undefined;
  return {
    name,
    description,
    systemPrompt: body.trim(),
    tools,
    approvalMode:
      typeof frontmatter['approvalMode'] === 'string'
        ? frontmatter['approvalMode']
        : undefined,
    model:
      typeof frontmatter['model'] === 'string'
        ? frontmatter['model']
        : undefined,
    color:
      typeof frontmatter['color'] === 'string'
        ? frontmatter['color']
        : undefined,
  };
}

/**
 * Renders an ExpertManifest back to the on-disk format.
 */
export function serializeExpertManifest(manifest: ExpertManifest): string {
  const fm: Record<string, unknown> = {
    name: manifest.name,
    description: manifest.description,
  };
  if (manifest.tools !== undefined) fm['tools'] = manifest.tools;
  if (manifest.approvalMode) fm['approvalMode'] = manifest.approvalMode;
  if (manifest.model) fm['model'] = manifest.model;
  if (manifest.color) fm['color'] = manifest.color;
  return `---\n${stringifyYaml(fm)}\n---\n${manifest.systemPrompt}\n`;
}

/**
 * Parses a single SKILL.md file as a KnowledgeChunk. Reads the few extension
 * fields (expertChunkId, author, createdAt) on top of the standard Skill fields.
 */
export function parseChunkFile(
  content: string,
  filePath: string,
): KnowledgeChunk {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new ExpertError(
      `Missing YAML frontmatter in ${filePath}`,
      ExpertErrorCode.INVALID_MANIFEST,
    );
  }
  const [, fm, body] = match;
  const frontmatter = parseYaml(fm) as Record<string, unknown>;
  const name = String(frontmatter['name'] ?? '');
  const description = String(frontmatter['description'] ?? '');
  const expertChunkId = String(frontmatter['expertChunkId'] ?? '');
  const createdAt = String(frontmatter['createdAt'] ?? '');
  if (!name || !description || !expertChunkId) {
    throw new ExpertError(
      `Chunk SKILL.md missing required fields (name/description/expertChunkId) at ${filePath}`,
      ExpertErrorCode.INVALID_MANIFEST,
    );
  }
  return {
    expertChunkId,
    name,
    description,
    author:
      typeof frontmatter['author'] === 'string'
        ? frontmatter['author']
        : undefined,
    createdAt,
    body: body.trim(),
    filePath,
  };
}

/**
 * Renders a chunk to its SKILL.md form.
 */
export function serializeChunk(chunk: KnowledgeChunk): string {
  const fm: Record<string, unknown> = {
    name: chunk.name,
    description: chunk.description,
    expertChunkId: chunk.expertChunkId,
    createdAt: chunk.createdAt,
  };
  if (chunk.author) fm['author'] = chunk.author;
  return `---\n${stringifyYaml(fm)}\n---\n${chunk.body}\n`;
}

/**
 * Top-level orchestrator for one project's virtual experts.
 * Demo scope: project-local only; no user-level resolution.
 */
export class ExpertManager {
  constructor(private readonly projectRoot: string) {}

  rootDir(): string {
    return getExpertsRootDir(this.projectRoot);
  }

  expertDir(name: string): string {
    return getExpertDir(this.projectRoot, name);
  }

  /**
   * Scaffold a new expert: directory layout, persona stub, git init,
   * optional remote + initial push.
   */
  async newExpert(
    name: string,
    description: string,
    remoteUrl?: string,
  ): Promise<LoadedExpert> {
    validateExpertName(name);
    const dir = this.expertDir(name);
    if (fsSync.existsSync(dir)) {
      throw new ExpertError(
        `Expert "${name}" already exists at ${dir}`,
        ExpertErrorCode.ALREADY_EXISTS,
        name,
      );
    }

    await fs.mkdir(path.join(dir, SKILLS_SUBDIR), { recursive: true });

    const manifest: ExpertManifest = {
      name,
      description,
      systemPrompt:
        `You are ${name}. ${description}\n\n` +
        `Use the attached knowledge skills as authoritative reference material.\n`,
    };
    await fs.writeFile(
      path.join(dir, 'expert.md'),
      serializeExpertManifest(manifest),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'ratings.jsonl'), '', 'utf8');
    await fs.writeFile(
      path.join(dir, '.gitignore'),
      '.expert-state.json\n',
      'utf8',
    );

    const git = simpleGit(dir);
    try {
      await initRepositoryWithMainBranch(git);
      await ensureLocalGitIdentity(git);
      await git.add('.');
      await git.commit(`init expert "${name}"`);
      if (remoteUrl) {
        await git.addRemote('origin', remoteUrl);
        await git.push(['-u', 'origin', 'main']);
      }
    } catch (err) {
      throw new ExpertError(
        `git setup failed: ${errMsg(err)}`,
        ExpertErrorCode.GIT_FAILED,
        name,
      );
    }

    await this.appendHostGitignore();
    return this.loadExpert(name);
  }

  /**
   * Clone an existing expert from a remote. Default name = repo basename.
   */
  async getExpertFromRemote(
    remoteUrl: string,
    asName?: string,
  ): Promise<LoadedExpert> {
    const name = asName ?? deriveNameFromUrl(remoteUrl);
    validateExpertName(name);
    const dir = this.expertDir(name);
    if (fsSync.existsSync(dir)) {
      throw new ExpertError(
        `Expert "${name}" already exists at ${dir}`,
        ExpertErrorCode.ALREADY_EXISTS,
        name,
      );
    }
    await fs.mkdir(this.rootDir(), { recursive: true });
    try {
      await simpleGit().clone(remoteUrl, dir);
      await ensureLocalGitIdentity(simpleGit(dir));
    } catch (err) {
      throw new ExpertError(
        `git clone failed: ${errMsg(err)}`,
        ExpertErrorCode.GIT_FAILED,
        name,
      );
    }
    await this.appendHostGitignore();
    return this.loadExpert(name);
  }

  /**
   * List all experts in the current project, with chunk count and last-commit hash.
   */
  async listExperts(): Promise<ExpertListEntry[]> {
    const root = this.rootDir();
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const result: ExpertListEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const expertMd = path.join(dir, 'expert.md');
      if (!fsSync.existsSync(expertMd)) continue;
      let manifest: ExpertManifest;
      try {
        manifest = parseExpertManifest(
          await fs.readFile(expertMd, 'utf8'),
          expertMd,
        );
      } catch {
        continue;
      }
      const chunkCount = await this.countChunks(dir);
      let lastCommit: string | null = null;
      try {
        const log = await simpleGit(dir).log({ maxCount: 1 });
        lastCommit = log.latest?.hash.slice(0, 7) ?? null;
      } catch {
        // not a git repo or unreadable — leave null
      }
      result.push({
        name: entry.name,
        rootDir: dir,
        description: manifest.description,
        chunkCount,
        lastCommit,
      });
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  /**
   * Load one expert: persona + all chunks.
   */
  async loadExpert(name: string): Promise<LoadedExpert> {
    validateExpertName(name);
    const dir = this.expertDir(name);
    const expertMd = path.join(dir, 'expert.md');
    if (!fsSync.existsSync(expertMd)) {
      throw new ExpertError(
        `Expert "${name}" not found at ${dir}`,
        ExpertErrorCode.NOT_FOUND,
        name,
      );
    }
    const manifest = parseExpertManifest(
      await fs.readFile(expertMd, 'utf8'),
      expertMd,
    );
    const chunks = await this.loadChunks(dir);
    return { name, rootDir: dir, manifest, chunks };
  }

  /**
   * Add a knowledge chunk and (best-effort) auto-push.
   * Returns the resulting chunk including its assigned id.
   */
  async addChunk(
    name: string,
    title: string,
    body: string,
    author?: string,
  ): Promise<KnowledgeChunk> {
    const expert = await this.loadExpert(name);
    const slug = await this.uniqueSlug(expert.rootDir, slugifyTitle(title));
    const createdAt = new Date().toISOString();
    const chunk: KnowledgeChunk = {
      expertChunkId: makeChunkId(slug, createdAt),
      name: slug,
      description: title,
      author,
      createdAt,
      body: body.trim(),
      filePath: path.join(expert.rootDir, SKILLS_SUBDIR, slug, 'SKILL.md'),
    };
    await fs.mkdir(path.dirname(chunk.filePath), { recursive: true });
    await fs.writeFile(chunk.filePath, serializeChunk(chunk), 'utf8');
    await this.commitAndPush(
      expert.rootDir,
      `add chunk "${title}" (${chunk.expertChunkId})`,
    );
    return chunk;
  }

  /**
   * Pull latest from origin and report what changed since the last sync,
   * using an `.expert-state.json` file to track the last seen ref.
   */
  async sync(name: string): Promise<{
    fetchedNew: boolean;
    summary: ArenaDiffSummary;
    rawDiff: string;
    commitMessages: string[];
  }> {
    const dir = this.expertDir(name);
    if (!fsSync.existsSync(dir)) {
      throw new ExpertError(
        `Expert "${name}" not found at ${dir}`,
        ExpertErrorCode.NOT_FOUND,
        name,
      );
    }
    const git = simpleGit(dir);
    const before = await safeRevParse(git, 'HEAD');
    try {
      await git.pull('origin', 'main', { '--ff-only': null });
    } catch (err) {
      throw new ExpertError(
        `git pull failed: ${errMsg(err)}`,
        ExpertErrorCode.GIT_FAILED,
        name,
      );
    }
    const after = await safeRevParse(git, 'HEAD');
    const stateFile = path.join(dir, '.expert-state.json');
    const lastSyncedRef = await readLastSyncedRef(stateFile);
    const fromRef = lastSyncedRef ?? before ?? after;
    let rawDiff = '';
    let commitMessages: string[] = [];
    if (fromRef && after && fromRef !== after) {
      try {
        rawDiff = await git.diff([`${fromRef}..${after}`]);
      } catch {
        // fall through with empty diff
      }
      try {
        const log = await git.log({ from: fromRef, to: after });
        commitMessages = log.all.map((c) => c.message);
      } catch {
        // leave empty
      }
    }
    if (after) {
      await fs.writeFile(
        stateFile,
        JSON.stringify({ lastSyncedRef: after }, null, 2),
        'utf8',
      );
    }
    return {
      fetchedNew: !!(fromRef && after && fromRef !== after),
      summary: summarizeUnifiedDiff(rawDiff),
      rawDiff,
      commitMessages,
    };
  }

  /**
   * Stage everything in the expert's repo, commit, and (best-effort) push to origin.
   * Used by addChunk and rating writes.
   */
  async commitAndPush(expertDir: string, message: string): Promise<void> {
    const git = simpleGit(expertDir);
    try {
      await git.add('.');
      const status = await git.status();
      if (status.files.length === 0) return;
      await git.commit(message);
    } catch (err) {
      throw new ExpertError(
        `git commit failed: ${errMsg(err)}`,
        ExpertErrorCode.GIT_FAILED,
      );
    }
    if (await hasOrigin(git)) {
      try {
        await git.push('origin', 'main');
      } catch (err) {
        // Demo policy: surface but don't roll back the local commit.
        throw new ExpertError(
          `git push failed: ${errMsg(err)}. Local commit kept; run \`git push\` manually in ${expertDir}.`,
          ExpertErrorCode.GIT_FAILED,
        );
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async loadChunks(expertDir: string): Promise<KnowledgeChunk[]> {
    const skillsRoot = path.join(expertDir, SKILLS_SUBDIR);
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const chunks: KnowledgeChunk[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (!fsSync.existsSync(skillMd)) continue;
      try {
        chunks.push(
          parseChunkFile(await fs.readFile(skillMd, 'utf8'), skillMd),
        );
      } catch {
        // skip unparseable
      }
    }
    chunks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return chunks;
  }

  private async countChunks(expertDir: string): Promise<number> {
    const skillsRoot = path.join(expertDir, SKILLS_SUBDIR);
    try {
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          fsSync.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md'))
        ) {
          count++;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  private async uniqueSlug(expertDir: string, base: string): Promise<string> {
    const skillsRoot = path.join(expertDir, SKILLS_SUBDIR);
    let candidate = base;
    let i = 2;
    while (fsSync.existsSync(path.join(skillsRoot, candidate))) {
      candidate = `${base}-${i++}`;
    }
    return candidate;
  }

  /**
   * Append `.qwen/experts/*\/` to the host project's `.gitignore` so nested
   * expert repos don't get tracked by the parent. Best-effort; silent on missing file.
   */
  private async appendHostGitignore(): Promise<void> {
    const giPath = path.join(this.projectRoot, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(giPath, 'utf8');
    } catch {
      return; // no host .gitignore — nothing to do
    }
    const marker = '.qwen/experts/';
    if (content.split('\n').some((line) => line.trim() === marker)) {
      return;
    }
    const suffix = content.endsWith('\n') ? '' : '\n';
    await fs.writeFile(giPath, `${content}${suffix}${marker}\n`, 'utf8');
  }
}

function deriveNameFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  const last = trimmed.split('/').pop() ?? 'expert';
  return last.replace(/\.git$/, '');
}

async function safeRevParse(
  git: SimpleGit,
  ref: string,
): Promise<string | null> {
  try {
    const out = await git.revparse([ref]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function hasOrigin(git: SimpleGit): Promise<boolean> {
  try {
    const remotes = await git.getRemotes(false);
    return remotes.some((r) => r.name === 'origin');
  } catch {
    return false;
  }
}

async function readLastSyncedRef(stateFile: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as { lastSyncedRef?: string };
    return parsed.lastSyncedRef ?? null;
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ensures the local repo can produce signed-or-unsigned commits without
 * tripping over a missing global identity or a hostile signing hook.
 *
 * - Disables `commit.gpgsign` locally (demo: no provenance guarantees).
 * - Falls back to a generic local identity only when the user has none
 *   configured globally — preserves real user identity when present.
 */
async function ensureLocalGitIdentity(git: SimpleGit): Promise<void> {
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  const have = async (key: string): Promise<boolean> => {
    try {
      const out = await git.raw(['config', '--get', key]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  };
  if (!(await have('user.name'))) {
    await git.addConfig('user.name', 'Qwen Code Expert', false, 'local');
  }
  if (!(await have('user.email'))) {
    await git.addConfig('user.email', 'expert@qwen-code.local', false, 'local');
  }
}
