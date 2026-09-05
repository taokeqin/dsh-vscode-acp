// test/session-order.mjs — which session opens, and how the sidebar orders them.
//
// Guards the failure that made history look lost: a session is created before its
// first message, so an untouched one (a + click, or a start that failed after
// creating it) carries the newest timestamp and beat every real conversation.
import { hasContent, pickPreferredSession, orderSessions, rootsOnly } from '../out/sessionOrder.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const S = (id, title, updatedAt, delegationDepth = 0) =>
  ({ sessionId: id, title, updatedAt, createdAt: updatedAt, cwd: '/ws', delegationDepth });

// The exact shape observed on disk when history "disappeared": two empty sessions
// left by failed starts, newer than both real conversations.
const real = [
  S('empty-new', null, 5000),
  S('empty-old', null, 4000),
  S('convo-mid', '这是一个新的session', 3000),
  S('convo-old', '这个项目是做什么的？', 2000),
];

console.log('\n1. content detection');
check('a titled session has content', () => assert.equal(hasContent(real[2]), true));
check('an untitled one does not', () => assert.equal(hasContent(real[0]), false));
check('whitespace is not content', () => assert.equal(hasContent(S('x', '   ', 1)), false));

console.log('\n2. openLast picks a conversation, not the newest blank');
check('skips the two newer empty sessions', () =>
  assert.equal(pickPreferredSession(real).sessionId, 'convo-mid'));
check('falls back to newest when nothing has content', () =>
  assert.equal(pickPreferredSession([real[0], real[1]]).sessionId, 'empty-new'));
check('undefined for an empty list', () => assert.equal(pickPreferredSession([]), undefined));

console.log('\n3. sidebar ordering');
const ordered = orderSessions(real, []);
check('conversations rank above blanks', () =>
  assert.deepEqual(ordered.map(m => m.sessionId), ['convo-mid', 'convo-old', 'empty-new', 'empty-old']));
const withOpen = orderSessions(real, ['empty-old']);
check('an open tab outranks everything, even when blank', () =>
  assert.equal(withOpen[0].sessionId, 'empty-old'));

console.log('\n4. delegated sub-agents');
const withSub = [...real, S('sub', 'delegated work', 9999, 1)];
check('depth > 0 is dropped', () => assert.ok(!rootsOnly(withSub).some(m => m.sessionId === 'sub')));
check('and never chosen despite being newest', () =>
  assert.notEqual(pickPreferredSession(withSub).sessionId, 'sub'));
check('unknown depth is kept (older logs)', () =>
  assert.ok(rootsOnly([S('u', 't', 1, null)]).length === 1));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
