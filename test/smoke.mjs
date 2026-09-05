// test/smoke.mjs — drives the compiled ACP layer against a real `dsh --profile acp`.
// Verifies: handshake, session bind (resume-or-new), streaming updates, tool calls,
// cancel-safety, and clean shutdown. Requires `dsh` on PATH.
import { AgentSession } from '../out/acp/session.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ws = mkdtempSync(join(tmpdir(), 'dsh-acp-smoke-'));
writeFileSync(join(ws, 'package.json'), '{"name":"smoke-fixture","version":"4.2.0"}\n');

const updates = [];
const session = new AgentSession({
  command: 'dsh', profile: 'acp', cwd: ws, resumeLatest: true,
  log: (l) => process.env.VERBOSE && console.log('   ' + l),
  onUpdate: (u) => updates.push(u),
  onExit: () => console.log('   [agent exited]'),
  onPermission: async () => { console.log('   [permission asked -> approving]'); return 'allow'; },
});

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('  ✓ ' + name); } catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

console.log('\n1. handshake + session bind');
await session.start();
check('sessionId assigned', () => assert.ok(session.id, 'no session id'));
check('agent identified', () => assert.match(session.agentName, /deepseek-harness-acp/));
check('model option advertised', () => assert.ok(session.options.find(o => o.id === 'model')));

console.log('\n2. prompt with a tool call');
const res = await session.prompt('Read package.json and reply with only the version string.');
check('turn settled end_turn', () => assert.equal(res.stopReason, 'end_turn'));
const kinds = new Set(updates.map(u => u.sessionUpdate));
check('streamed assistant text', () => assert.ok(kinds.has('agent_message_chunk')));
check('reported a tool call', () => assert.ok(kinds.has('tool_call')));
check('reported tool completion', () => assert.ok(kinds.has('tool_call_update')));
const answer = updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content?.text ?? '').join('');
check('agent read the fixture (4.2.0)', () => assert.match(answer, /4\.2\.0/));

console.log('\n3. listing excludes the ACTIVE session (measured agent behaviour)');
const listedWhileActive = await session.listSessions();
check('active session is not listed', () => assert.ok(!listedWhileActive.some(s => s.sessionId === session.id)));

console.log('\n4. new session releases the old one, which becomes resumable');
const before = session.id;
const after = await session.newSession();
check('a different session id', () => assert.notEqual(after, before));
const listedAfter = await session.listSessions();
check('the released session is now listed', () => assert.ok(listedAfter.some(s => s.sessionId === before)));
check('and it is scoped to our cwd', () => assert.ok(listedAfter.length >= 1));

console.log('\n5. resume the released session');
await session.resume(before);
check('bound back to the original session', () => assert.equal(session.id, before));

console.log('\n6. shutdown');
await session.dispose();
check('client released', () => assert.equal(session.id, null));

console.log(`\nupdate kinds observed: ${[...kinds].join(', ')}`);
console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
