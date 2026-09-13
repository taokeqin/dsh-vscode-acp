// test/context.mjs — how attached context becomes the single string ACP accepts.
//
// The context strip is host-owned and serialized in TypeScript; this pins the wire
// shape so a chip cannot quietly change what the agent receives. A file is only ever
// the harness's `@path` mention — never its content: the file on disk is the source of
// truth and the agent reads it. A selection is the one thing inlined, because the user
// pointed at that exact text.
import { withContext, contextKey, contextLabel, selectionText } from '../out/context.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const file = (path, enabled = true) => ({ kind: 'file', path, enabled });
const sel = (over = {}) => ({
  kind: 'selection', path: 'src/a.ts', line: 1, endLine: 2, lang: 'ts',
  text: 'let x = 1;', enabled: true, ...over,
});

console.log('\n1. no context leaves the prompt untouched');
check('empty list', () => assert.equal(withContext([], 'hello'), 'hello'));
check('only disabled chips', () =>
  assert.equal(withContext([file('src/a.ts', false)], 'hello'), 'hello'));

console.log('\n2. files are references, never content');
check('one file', () => assert.equal(withContext([file('src/a.ts')], 'why?'), '@src/a.ts\nwhy?'));
check('several files share one line', () =>
  assert.equal(withContext([file('a.ts'), file('b.ts')], 'why?'), '@a.ts @b.ts\nwhy?'));
check('a path with a space uses the quoted spelling', () =>
  assert.equal(withContext([file('my docs/a.ts')], 'x'), '@"my docs/a.ts"\nx'));
check('no file body is ever carried', () => {
  const out = withContext([file('src/a.ts')], 'why?');
  assert.equal(out, '@src/a.ts\nwhy?');
});

console.log('\n3. a selection is a fenced block with its location');
check('location header and fence', () => {
  const out = withContext([sel()], 'why?');
  assert.match(out, /^src\/a\.ts:1-2\n\n```ts\nlet x = 1;\n```\n\nwhy\?$/);
});
check('selectionText is that block and nothing else', () =>
  assert.equal(selectionText(sel()), 'src/a.ts:1-2\n\n```ts\nlet x = 1;\n```\n'));
check('a disabled selection is left out', () =>
  assert.equal(withContext([sel({ enabled: false })], 'q'), 'q'));

console.log('\n4. mentions come first, then selection blocks');
check('a mention is ahead of a selection regardless of attach order', () => {
  const out = withContext([sel(), file('z.ts')], 'q');
  assert.ok(out.indexOf('@z.ts') < out.indexOf('src/a.ts:1-2'), out);
});
check('two selections keep their order', () => {
  const out = withContext([sel(), sel({ path: 'b.ts', line: 5, endLine: 6 })], 'q');
  assert.ok(out.indexOf('src/a.ts:1-2') < out.indexOf('b.ts:5-6'), out);
});

console.log('\n5. identity and label');
check('a file key is its path', () => assert.equal(contextKey(file('src/a.ts')), 'file:src/a.ts'));
// One selection chip per file: moving the range updates it rather than adding a
// second chip, which is what lets the checkbox be a stable on/off switch.
check('a selection key is its file, not its range', () =>
  assert.equal(contextKey(sel()), 'sel:src/a.ts'));
check('and it does not change with the range', () =>
  assert.equal(contextKey(sel({ line: 40, endLine: 50 })), 'sel:src/a.ts'));
check('a label is the mention', () => assert.equal(contextLabel(file('src/a.ts')), '@src/a.ts'));
check('a selection label is its range', () =>
  assert.equal(contextLabel(sel()), 'src/a.ts:1-2'));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
