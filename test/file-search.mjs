// test/file-search.mjs — ranking for the composer's `@` menu.
//
// The ranking is what makes typing `@conn` useful in a large tree, so the orderings are
// pinned: basename prefix beats basename substring beats path substring beats a loose
// subsequence, and the file in the active editor heads the empty query.
import { rankFiles } from '../out/fileSearch.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const files = [
  'README.md',
  'docs/connection.md',
  'src/fileSearch.ts',
  'src/panel/chatPanel.ts',
  'src/panel/html.ts',
];

console.log('\n1. matching order');
check('basename prefix wins', () =>
  assert.equal(rankFiles(files, 'html')[0], 'src/panel/html.ts'));
check('basename substring beats path substring', () =>
  assert.equal(rankFiles(files, 'panel')[0], 'src/panel/chatPanel.ts'));
check('a path substring matches too', () =>
  assert.ok(rankFiles(files, 'docs').includes('docs/connection.md')));
check('case-insensitive', () => assert.equal(rankFiles(files, 'README')[0], 'README.md'));
check('a loose subsequence still matches', () =>
  assert.ok(rankFiles(files, 'sphtml').includes('src/panel/html.ts')));
check('no match yields nothing', () => assert.deepEqual(rankFiles(files, 'zzzz'), []));
check('shorter paths win ties', () => {
  const tied = ['a/b/c/file.ts', 'x/file.ts'];
  assert.equal(rankFiles(tied, 'file')[0], 'x/file.ts');
});

console.log('\n2. the active editor file');
check('heads the empty query', () =>
  assert.equal(rankFiles(files, '', { active: 'docs/connection.md' })[0], 'docs/connection.md'));
check('but never overrides a real match', () =>
  assert.equal(rankFiles(files, 'html', { active: 'README.md' })[0], 'src/panel/html.ts'));
check('an active file that does not match is not injected', () =>
  assert.ok(!rankFiles(files, 'html', { active: 'README.md' }).includes('README.md')));

console.log('\n3. shape');
check('the limit is respected', () => assert.equal(rankFiles(files, '', { limit: 2 }).length, 2));
check('the input array is not mutated', () => {
  const before = [...files];
  rankFiles(files, 'pa');
  assert.deepEqual(files, before);
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
