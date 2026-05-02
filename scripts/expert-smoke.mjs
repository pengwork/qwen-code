#!/usr/bin/env node
/**
 * End-to-end smoke test for the /expert system.
 *
 * Layout we set up:
 *   /tmp/expert-smoke-<rand>/
 *     remote.git/      (bare repo — pretend "GitHub")
 *     alice/           (User A's project root)
 *     bob/             (User B's project root)
 *
 * Walks through the SOP using the real ExpertManager + ratings + activate APIs
 * (the same code paths the /expert slash command exercises).
 */

import {
  mkdtempSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  ExpertManager,
  activateExpert,
  appendRating,
  aggregateAll,
  parseRatingLabel,
} from '@qwen-code/qwen-code-core';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'expert-smoke-'));
const REMOTE = path.join(ROOT, 'remote.git');
const ALICE = path.join(ROOT, 'alice');
const BOB = path.join(ROOT, 'bob');
const REMOTE_URL = 'file://' + REMOTE;

function header(s) {
  console.log('\n\x1b[1;36m━━━ ' + s + ' \x1b[0m'.padEnd(80, '━'));
}
function ok(s) {
  console.log('  \x1b[32m✓\x1b[0m ' + s);
}
function info(s) {
  console.log('    ' + s);
}

async function main() {
  console.log('Workdir:', ROOT);

  header('SETUP — bare remote + two project roots');
  await simpleGit(ROOT).init([REMOTE, '--bare', '--initial-branch=main']);
  mkdirSync(ALICE, { recursive: true });
  mkdirSync(BOB, { recursive: true });
  ok(`bare remote ${REMOTE}`);
  ok(`alice cwd  ${ALICE}`);
  ok(`bob   cwd  ${BOB}`);

  const alice = new ExpertManager(ALICE);
  const bob = new ExpertManager(BOB);

  header('ALICE: /expert new pg-tuning <url> "PG perf tuner"');
  const created = await alice.newExpert(
    'pg-tuning',
    'PG perf tuner',
    REMOTE_URL,
  );
  ok(`created ${created.name} at ${created.rootDir}`);
  info(`description: ${created.manifest.description}`);
  // Verify remote received the initial commit
  const remoteLog0 = await simpleGit(REMOTE).log(['main']);
  info(`remote now has ${remoteLog0.total} commit(s); HEAD: ${remoteLog0.latest?.message}`);

  header('ALICE: /expert add pg-tuning "VACUUM tuning" :: <body>');
  const c1 = await alice.addChunk(
    'pg-tuning',
    'VACUUM tuning',
    'Run VACUUM ANALYZE on high-churn tables. autovacuum_vacuum_scale_factor=0.05 is a sane default.',
    'alice',
  );
  ok(`chunk ${c1.expertChunkId} (${c1.name}) added`);

  header('ALICE: /expert add pg-tuning "INDEX choice" :: <body>');
  const c2 = await alice.addChunk(
    'pg-tuning',
    'INDEX choice',
    'Prefer btree for equality; gin for arrays/jsonb; brin for time-series.',
    'alice',
  );
  ok(`chunk ${c2.expertChunkId} (${c2.name}) added`);

  const remoteLog1 = await simpleGit(REMOTE).log(['main']);
  info(`remote has ${remoteLog1.total} commit(s) after Alice's adds`);

  header('BOB: /expert get <url>');
  const got = await bob.getExpertFromRemote(REMOTE_URL);
  ok(`bob imported "${got.name}" with ${got.chunks.length} chunk(s)`);
  for (const chunk of got.chunks) {
    info(`• ${chunk.expertChunkId}  ${chunk.name} — ${chunk.description}`);
  }

  header('BOB: /expert list pg-tuning');
  const beforeRating = await aggregateAll(bob, got.name);
  for (const chunk of got.chunks) {
    const agg = beforeRating.get(chunk.expertChunkId);
    info(`  ${chunk.expertChunkId}  ${chunk.name}  ${agg?.count ? `[avg ${agg.avg.toFixed(1)}, n=${agg.count}]` : '[unrated]'}`);
  }

  header('BOB: /expert rate pg-tuning <id> good "spot on"');
  const targetChunk = got.chunks[0];
  await appendRating(bob, got.name, {
    chunkId: targetChunk.expertChunkId,
    rater: 'bob',
    rating: parseRatingLabel('good'),
    comment: 'spot on',
    ts: new Date().toISOString(),
  });
  ok(`bob rated ${targetChunk.expertChunkId} → good`);

  // Bob also rates the second chunk fine
  await appendRating(bob, got.name, {
    chunkId: got.chunks[1].expertChunkId,
    rater: 'bob',
    rating: parseRatingLabel('fine'),
    comment: undefined,
    ts: new Date().toISOString(),
  });
  ok(`bob rated ${got.chunks[1].expertChunkId} → fine`);

  header('ALICE: /expert sync pg-tuning');
  const synced = await alice.sync('pg-tuning');
  ok(`fetched new = ${synced.fetchedNew}`);
  ok(`new commits (${synced.commitMessages.length}):`);
  for (const m of synced.commitMessages) info(`  • ${m.split('\n')[0]}`);
  ok(`change summary: ${synced.summary.files.length} file(s), +${synced.summary.additions}/-${synced.summary.deletions}`);
  for (const f of synced.summary.files) info(`  ${f.path}  +${f.additions}/-${f.deletions}`);

  header('ALICE: /expert list pg-tuning (after sync)');
  const aliceExpert = await alice.loadExpert('pg-tuning');
  const aliceRatings = await aggregateAll(alice, 'pg-tuning');
  info(`# ${aliceExpert.name} — ${aliceExpert.manifest.description}`);
  for (const chunk of aliceExpert.chunks) {
    const agg = aliceRatings.get(chunk.expertChunkId);
    const tag = agg && agg.count > 0
      ? `[avg ${agg.avg.toFixed(1)}, n=${agg.count}]`
      : '[unrated]';
    info(`  ${chunk.expertChunkId}  ${chunk.name}  ${tag}`);
    info(`      ${chunk.description}`);
    if (agg && agg.comments.length > 0) {
      for (const c of agg.comments) {
        const cm = c.comment ? ` — "${c.comment}"` : '';
        info(`        ${c.rater}: ${c.rating}${cm}`);
      }
    }
  }

  header('ALICE: /expert use pg-tuning');
  const activation = await activateExpert(alice, ALICE, 'pg-tuning');
  ok(`activated; ${activation.registeredSkillNames.length} skill(s) exposed`);
  for (const name of activation.registeredSkillNames) {
    const linkPath = path.join(ALICE, '.qwen', 'skills', name);
    const st = lstatSync(linkPath);
    const target = st.isSymbolicLink() ? readlinkSync(linkPath) : '(copy)';
    info(`• .qwen/skills/${name}  ⤍  ${target}`);
  }
  info('SubagentConfig.systemPrompt preview:');
  console.log('  ' + activation.subagent.systemPrompt.split('\n').join('\n  '));

  header('VERIFY — bare remote final state');
  const finalLog = await simpleGit(REMOTE).log(['main']);
  ok(`remote main has ${finalLog.total} commit(s):`);
  for (const c of finalLog.all.slice(0, 10)) {
    info(`  ${c.hash.slice(0, 7)}  ${c.message.split('\n')[0]}  (${c.author_name})`);
  }

  console.log('\n\x1b[1;32m✓ All steps completed successfully.\x1b[0m');
  console.log('Workdir kept for inspection:', ROOT);
}

main().catch((err) => {
  console.error('\n\x1b[31m✗ Smoke test failed:\x1b[0m', err);
  console.error('Workdir kept for debugging:', ROOT);
  process.exit(1);
});
