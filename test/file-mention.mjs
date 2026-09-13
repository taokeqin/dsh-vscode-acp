// test/file-mention.mjs — the `@path` spelling used to add a file to a prompt.
//
// dsh's grammar is `@path` or `@"path with spaces"`. Getting it wrong produces a
// token the harness reads as something else (or as prose), and no error is raised —
// the file is silently not referenced — so the representable/not-representable cases
// are pinned here.
import { formatFileMention } from '../out/fileMention.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. plain workspace paths');
check('a nested path is a bare @token', () =>
  assert.equal(formatFileMention('src/acp/connection.ts'), '@src/acp/connection.ts'));
check('a dotfile is left alone', () => assert.equal(formatFileMention('.gitignore'), '@.gitignore'));

console.log('\n2. whitespace uses the quoted spelling');
check('a space quotes the whole path', () =>
  assert.equal(formatFileMention('my notes/design doc.md'), '@"my notes/design doc.md"'));

console.log('\n3. paths the grammar cannot carry are refused, not mangled');
check('empty', () => assert.equal(formatFileMention(''), null));
check('whitespace only', () => assert.equal(formatFileMention('   '), null));
check('a double quote', () => assert.equal(formatFileMention('a"b.ts'), null));
check('a control character, including a tab', () => {
  assert.equal(formatFileMention('a\u0000b.ts'), null);
  assert.equal(formatFileMention('a\tb.ts'), null);
});
check('an over-long prose blob', () => assert.equal(formatFileMention('a'.repeat(401)), null));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
