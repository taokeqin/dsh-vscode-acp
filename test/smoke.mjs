// test/smoke.mjs — drives the compiled ACP layer against a real `dsh --profile acp`.
// The central claim under test: ONE agent process serving MANY concurrent sessions,
// which is what the editor-tab model depends on.
import { AcpConnection } from '../out/acp/connection.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ws = mkdtempSync(join(tmpdir(), 'dsh-acp-smoke-'));
writeFileSync(join(ws, 'package.json'), '{"name":"smoke-fixture","version":"4.2.0"}\n');
writeFileSync(join(ws, 'colour.txt'), 'the colour is chartreuse\n');

const updates = new Map(); // sessionId -> update[]
const conn = new AcpConnection({
  command: 'dsh', profile: 'acp', cwd: ws,
  log: (l) => process.env.VERBOSE && console.log('   ' + l),
  onExit: () => console.log('   [agent exited]'),
  onPermission: async () => 'allow',
});

let failures = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const track = (id) => { const a = []; updates.set(id, a); return conn.subscribe(id, (u) => a.push(u)); };
const textOf = (id) => (updates.get(id) ?? []).filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content?.text ?? '').join('');

console.log('\n1. handshake');
await conn.ensureStarted();
await check('agent identified', () => assert.match(conn.agentName, /deepseek-harness-acp/));
await check('idempotent start', async () => { await conn.ensureStarted(); assert.ok(conn.running); });

console.log('\n2. two concurrent sessions on one process');
const a = await conn.newSession();
const b = await conn.newSession();
track(a); track(b);
await check('distinct session ids', () => assert.notEqual(a, b));
await check('per-session config options', () => {
  assert.ok(conn.configOptions(a).find(o => o.id === 'model'));
  assert.ok(conn.configOptions(b).find(o => o.id === 'model'));
});

console.log('\n3. concurrent prompts stay isolated');
const t0 = Date.now();
const [ra, rb] = await Promise.all([
  conn.prompt(a, 'Read package.json and reply with only the version string.'),
  conn.prompt(b, 'Read colour.txt and reply with only the colour word.'),
]);
console.log(`  (both turns settled in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
await check('both turns ended normally', () => {
  assert.equal(ra.stopReason, 'end_turn'); assert.equal(rb.stopReason, 'end_turn');
});
await check('session A got its own answer (4.2.0)', () => assert.match(textOf(a), /4\.2\.0/));
await check('session B got its own answer (chartreuse)', () => assert.match(textOf(b), /chartreuse/i));
await check('no cross-talk: A never saw B\'s answer', () => assert.doesNotMatch(textOf(a), /chartreuse/i));
await check('no cross-talk: B never saw A\'s answer', () => assert.doesNotMatch(textOf(b), /4\.2\.0/));
await check('each session saw its own tool calls', () => {
  for (const id of [a, b]) {
    const kinds = new Set((updates.get(id) ?? []).map(u => u.sessionUpdate));
    assert.ok(kinds.has('tool_call'), `session ${id.slice(0,8)} saw no tool_call`);
  }
});

console.log('\n4. listing is scoped to this workspace and excludes ACTIVE sessions');
const listed = await conn.listSessions();
await check('neither open session is listed', () => {
  const ids = listed.map(s => s.sessionId);
  assert.ok(!ids.includes(a)); assert.ok(!ids.includes(b));
});
await check('no session from another workspace leaks in', () => {
  const foreign = listed.filter(s => s.cwd !== ws);
  assert.equal(foreign.length, 0,
    `${foreign.length} foreign sessions, e.g. ${foreign[0]?.cwd}`);
});
console.log(`  (${listed.length} listed for this workspace; the agent knows many more)`);

console.log('\n5. closing releases a session for reopening');
await conn.closeSession(a);
const afterClose = (await conn.listSessions()).map(s => s.sessionId);
await check('closed session becomes listable', () => assert.ok(afterClose.includes(a)));
await check('still-open session stays hidden', () => assert.ok(!afterClose.includes(b)));
await check('closed session can be resumed', async () => { await conn.resume(a); });
await check('resuming an ACTIVE session is rejected', async () => {
  await assert.rejects(() => conn.resume(b), /already active/i);
});

console.log('\n6. shutdown closes everything');
await conn.dispose();
await check('connection released', () => assert.equal(conn.running, false));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
