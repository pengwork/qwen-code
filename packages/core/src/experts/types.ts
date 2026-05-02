/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types for the Virtual Expert system: a multi-user-collaborative
 * agent persona + knowledge base, where each expert is a self-contained
 * git repo at `.qwen/experts/<name>/`.
 */

/**
 * Persona manifest stored as `.qwen/experts/<name>/expert.md`.
 * The file format is byte-compatible with a SubAgent .md file
 * so the same YAML frontmatter parser can read it.
 */
export interface ExpertManifest {
  /** Unique name (matches the directory name). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** System prompt body — defines the expert persona. */
  systemPrompt: string;
  /** Optional SubAgent passthrough fields. */
  tools?: string[];
  approvalMode?: string;
  model?: string;
  color?: string;
}

/**
 * One unit of curated knowledge attached to an expert.
 * Stored as `.qwen/experts/<name>/skills/<slug>/SKILL.md`,
 * which is also a valid Skill that the SkillManager can load.
 */
export interface KnowledgeChunk {
  /** Stable id used to anchor ratings. */
  expertChunkId: string;
  /** Skill name (matches the slug). */
  name: string;
  /** Short description used by Skill activation. */
  description: string;
  /** Free-form contributor handle. */
  author?: string;
  /** ISO timestamp written by `addChunk`. */
  createdAt: string;
  /** Markdown body of the chunk. */
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
}

/**
 * One rating entry from `ratings.jsonl`. Append-only;
 * "change my rating" means appending a new line.
 */
export interface Rating {
  chunkId: string;
  rater: string;
  /** 1=BAD, 2=FINE, 3=GOOD (matches UserFeedbackRating). */
  rating: 1 | 2 | 3;
  comment?: string;
  ts: string;
}

/**
 * Aggregate over all ratings for one chunk.
 */
export interface RatingAggregate {
  chunkId: string;
  count: number;
  /** Mean rating, or null when count === 0. */
  avg: number | null;
  comments: Array<Pick<Rating, 'rater' | 'rating' | 'comment' | 'ts'>>;
}

/**
 * In-memory snapshot of an expert loaded from disk.
 */
export interface LoadedExpert {
  name: string;
  rootDir: string;
  manifest: ExpertManifest;
  chunks: KnowledgeChunk[];
}

/**
 * Listing entry returned by `listExperts`.
 */
export interface ExpertListEntry {
  name: string;
  rootDir: string;
  description: string;
  chunkCount: number;
  /** Short hash of the most recent commit, or null if unavailable. */
  lastCommit: string | null;
}

/** Error thrown by ExpertManager operations. */
export class ExpertError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly expertName?: string,
  ) {
    super(message);
    this.name = 'ExpertError';
  }
}

export const ExpertErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INVALID_NAME: 'INVALID_NAME',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  GIT_FAILED: 'GIT_FAILED',
  IO_FAILED: 'IO_FAILED',
} as const;
export type ExpertErrorCode =
  (typeof ExpertErrorCode)[keyof typeof ExpertErrorCode];
