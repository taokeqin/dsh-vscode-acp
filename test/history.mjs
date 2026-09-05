// test/history.mjs — transcript recovery against real on-disk dsh session logs.
// Asserts structure and failure behaviour only; conversation text is never printed.
import { loadTranscript, parseTranscript, slugForCwd, loadSessionMeta, listSessionIdsOnDisk } from '../out/history/store.js';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
let failures = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. cwd slug');
await check('wraps joined segments in --', () =>
  assert.equal(slugForCwd('/Users/hacken/Code/egi/business-central'), '--Users-hacken-Code-egi-business-central--'));
await check('keeps hyphens inside a segment', () =>
  assert.equal(slugForCwd('/a/b-c'), '--a-b-c--'));

console.log('\n2. failure modes return a reason, never throw');
await check('unknown session id', async () => {
  const r = await loadTranscript({ dshHome: DSH_HOME, sessionId: 'does-not-exist-000', maxEntries: 10 });
  assert.equal(r.ok, false); assert.match(r.reason, /no on-disk log/);
});
await check('missing DSH_HOME', async () => {
  const r = await loadTranscript({ dshHome: '/nonexistent/dsh/home', sessionId: 'x', maxEntries: 10 });
  assert.equal(r.ok, false);
});
await check('garbage jsonl yields zero entries, not a throw', () => {
  const r = parseTranscript('not json\n{"broken":\n\n', 10);
  assert.equal(r.ok, true); assert.equal(r.entries.length, 0);
});
await check('unknown record types are ignored', () => {
  const r = parseTranscript(JSON.stringify({ type: 'some/future/record', data: {} }), 10);
  assert.equal(r.ok, true); assert.equal(r.entries.length, 0);
});

console.log('\n3. synthetic transcript maps to the right shapes');
const synth = [
  { type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' } },
  { type: 'tool/result', surfaceOp: 'append', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }], isError: false }] } } },
  { type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
      { type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }] } } },
].map(o => JSON.stringify(o)).join('\n');
const sr = parseTranscript(synth, 100);
await check('three entries in order', () => {
  assert.equal(sr.entries.length, 3);
  assert.deepEqual(sr.entries.map(e => e.kind), ['user', 'tool', 'assistant']);
});
await check('tool row keeps name and arguments separate', () => {
  // The name used to have the raw JSON appended, which was unreadable in a row.
  assert.equal(sr.entries[1].name, 'read');
  assert.equal(sr.entries[1].detail, 'a.ts');
});
await check('assistant splits text and reasoning', () => {
  assert.equal(sr.entries[2].text, 'answer');
  assert.equal(sr.entries[2].reasoning, 'thinking');
});
await check('maxEntries keeps the tail', () => assert.deepEqual(parseTranscript(synth, 1).entries.map(e => e.kind), ['assistant']));
await check('truncation is flagged', () => assert.equal(parseTranscript(synth, 1).truncated, true));

console.log('\n4. real on-disk sessions');
const root = join(DSH_HOME, 'sessions');
const real = [];
if (existsSync(root)) {
  for (const slug of readdirSync(root)) {
    for (const sid of readdirSync(join(root, slug))) {
      if (existsSync(join(root, slug, sid, 'session.jsonl.zstd'))) real.push(sid);
    }
  }
}
console.log(`  (found ${real.length} persisted sessions)`);
await check('at least one real session to test', () => assert.ok(real.length > 0));
let restored = 0, empty = 0;
for (const sid of real) {
  const r = await loadTranscript({ dshHome: DSH_HOME, sessionId: sid, maxEntries: 200 });
  if (!r.ok) { failures++; console.log('  ✗ ' + sid.slice(0, 12) + ' failed: ' + r.reason); continue; }
  if (r.entries.length > 0) restored++; else empty++;
}
await check('every real session parsed without error', () => assert.equal(restored + empty, real.length));
await check('most sessions yield entries', () => assert.ok(restored > 0, `${restored} with entries, ${empty} empty`));
console.log(`  → ${restored} with content, ${empty} empty`);

const loaded = [];
for (const sid of real) loaded.push([sid, await loadTranscript({ dshHome: DSH_HOME, sessionId: sid, maxEntries: 200 })]);
const biggest = loaded
  .filter(([, r]) => r.ok).sort((a, b) => b[1].scanned - a[1].scanned)[0];
if (biggest) {
  const [sid, r] = biggest;
  console.log(`  largest: ${sid.slice(0, 12)}… — ${r.scanned} records → ${r.entries.length} entries, truncated=${r.truncated}`);
  const kinds = {};
  for (const e of r.entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log('  entry kinds:', JSON.stringify(kinds));
  check('largest session produced all three kinds', () => {
    assert.ok(kinds.user > 0 && kinds.assistant > 0 && kinds.tool > 0);
  });
}

console.log('\n5. session metadata (switcher)');
await check('unknown id degrades to nulls, never throws', async () => {
  const m = await loadSessionMeta(DSH_HOME, 'nope-000');
  assert.equal(m.title, null); assert.equal(m.sessionId, 'nope-000');
});
if (biggest) {
  const [sid] = biggest;
  const t0 = Date.now();
  const m = await loadSessionMeta(DSH_HOME, sid);
  const metaMs = Date.now() - t0;
  const t1 = Date.now();
  await loadTranscript({ dshHome: DSH_HOME, sessionId: sid, maxEntries: 200 });
  const fullMs = Date.now() - t1;
  await check('title recovered', () => assert.ok(m.title && m.title.length > 0));
  await check('createdAt recovered', () => assert.ok(typeof m.createdAt === 'number' && m.createdAt > 0));
  await check('updatedAt recovered', () => assert.ok(typeof m.updatedAt === 'number' && m.updatedAt > 0));
  await check(`frame budget beats a full read (${metaMs}ms vs ${fullMs}ms)`, () => assert.ok(metaMs < fullMs));
  console.log(`  title length: ${m.title.length} chars (content not printed)`);
}
let titled = 0;
for (const [sid] of loaded) { const m = await loadSessionMeta(DSH_HOME, sid); if (m.title) titled++; }
console.log(`  ${titled}/${loaded.length} sessions have a usable title`);

console.log('\n6. on-disk session listing (the sidebar path, no agent needed)');
const here = '/Users/hacken/Code/dsh-vscode-acp';
const diskIds = listSessionIdsOnDisk(DSH_HOME, here);
console.log(`  ${diskIds.length} sessions found for ${here}`);
await check('finds this workspace\'s sessions without an agent', () => assert.ok(diskIds.length > 0));
await check('unknown workspace yields none, never throws', () =>
  assert.equal(listSessionIdsOnDisk(DSH_HOME, '/nope/not/a/workspace').length, 0));
await check('missing DSH_HOME yields none', () =>
  assert.equal(listSessionIdsOnDisk('/nonexistent', here).length, 0));

let depth0 = 0, depthN = 0, unknown = 0;
for (const sid of real) {
  const m = await loadSessionMeta(DSH_HOME, sid);
  if (m.delegationDepth === 0) depth0++;
  else if (typeof m.delegationDepth === 'number') depthN++;
  else unknown++;
}
console.log(`  delegationDepth: ${depth0} root, ${depthN} delegated, ${unknown} unknown`);
await check('delegated sub-sessions are detectable and would be filtered', () => assert.ok(depthN > 0));
await check('cwd is recovered from the header', async () => {
  const m = await loadSessionMeta(DSH_HOME, diskIds[0]);
  assert.equal(typeof m.cwd, 'string');
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
