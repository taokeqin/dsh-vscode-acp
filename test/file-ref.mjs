// test/file-ref.mjs — recognising file references in agent output.
// Strictness is the point: a false positive makes prose look clickable and then
// fails on click, which is worse than plain text.
import { parseFileRef, parseFileRefLoose } from '../out/fileRef.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. what should be recognised');
check('path with a line', () =>
  assert.deepEqual(parseFileRef('src/panel/html.ts:42'), { path: 'src/panel/html.ts', line: 42 }));
check('path with a range', () =>
  assert.deepEqual(parseFileRef('src/a.ts:42-51'), { path: 'src/a.ts', line: 42, endLine: 51 }));
check('bare path', () => assert.deepEqual(parseFileRef('README.md'), { path: 'README.md' }));
check('relative prefix', () => assert.equal(parseFileRef('./src/a.ts').path, './src/a.ts'));
check('absolute path', () => assert.equal(parseFileRef('/Users/x/a.ts:9').line, 9));
check('colon-separated range', () => assert.equal(parseFileRef('a.ts:3:7').endLine, 7));

console.log('\n2. what must be rejected');
for (const bad of [
  'and/or', 'sender/receiver', 'https://example.com/a.ts', 'http://x/y.md:3',
  'hello world', '', 'src/', 'a.ts extra', ':42', '3.14',
]) {
  check(`rejects ${JSON.stringify(bad)}`, () => assert.equal(parseFileRef(bad), null));
}
check('a URL is not rescued by the loose form either', () =>
  assert.equal(parseFileRefLoose('https://example.com/a.ts'), null));

console.log('\n3. edge cases');
check('line 0 degrades to a plain path', () =>
  assert.deepEqual(parseFileRef('a.ts:0'), { path: 'a.ts' }));
check('a backwards range drops the end', () =>
  assert.deepEqual(parseFileRef('a.ts:50-10'), { path: 'a.ts', line: 50 }));
check('an absurdly long token is refused', () =>
  assert.equal(parseFileRef('a/'.repeat(300) + 'x.ts'), null));
check('trailing punctuation is stripped only by the loose form', () => {
  assert.equal(parseFileRef('see src/a.ts.'), null);
  assert.equal(parseFileRefLoose('src/a.ts.').path, 'src/a.ts');
});
check('trailing paren from a citation', () =>
  assert.equal(parseFileRefLoose('src/a.ts:12)').line, 12));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
