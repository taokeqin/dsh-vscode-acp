// test/file-refs-decorate.mjs — which code spans become clickable references.
//
// Decoration happens in the host because only it can check the filesystem; the rule
// is that a span is decorated when the path resolves INSIDE the workspace and
// exists. Anything else stays plain text, so no link refuses on click.
import { decorateFileRefs, resolveInWorkspace } from '../out/decorateFileRefs.js';
import { parseMarkdown, inlineToText } from '../out/markdown.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const ROOT = '/ws';
const present = new Set(['/ws/src/a.ts', '/ws/README.md']);
const deps = { workspaceRoot: ROOT, exists: (p) => present.has(p) };
const decorate = (md) => decorateFileRefs(parseMarkdown(md), deps);
const inlines = (blocks) => blocks.flatMap((b) => (Array.isArray(b.v) ? b.v : b.items ? b.items.flat() : []));
const kinds = (md) => inlines(decorate(md)).map((n) => n.t);

console.log('\n1. decorated');
check('an existing path becomes a file ref', () => {
  const [node] = inlines(decorate('see `src/a.ts` here')).filter((n) => n.t === 'file');
  assert.equal(node.path, 'src/a.ts');
});
check('a line number carries through', () => {
  const [node] = inlines(decorate('`src/a.ts:42`')).filter((n) => n.t === 'file');
  assert.equal(node.line, 42);
});
check('a range carries through', () => {
  const [node] = inlines(decorate('`src/a.ts:10-20`')).filter((n) => n.t === 'file');
  assert.deepEqual([node.line, node.endLine], [10, 20]);
});
check('refs inside bold are found', () => {
  const strong = inlines(decorate('**`src/a.ts`**')).find((n) => n.t === 'strong');
  assert.equal(strong.v[0].t, 'file');
});
check('refs inside list items are found', () =>
  assert.ok(kinds('- `src/a.ts`').includes('file')));

console.log('\n2. left as plain code');
check('a path that does not exist', () => assert.deepEqual(kinds('`src/missing.ts`'), ['code']));
check('a path outside the workspace', () => assert.deepEqual(kinds('`/etc/passwd`'), ['code']));
check('a traversal attempt', () => assert.deepEqual(kinds('`../../secrets.env`'), ['code']));
check('a shell command', () => assert.deepEqual(kinds('`npm run build`'), ['code']));
check('prose with a slash', () => assert.deepEqual(kinds('`and/or`'), ['code']));

console.log('\n3. untouched regions');
check('fenced code blocks are never decorated', () => {
  const [block] = decorate('```\nsrc/a.ts:1\n```');
  assert.equal(block.t, 'code');
  assert.equal(block.v, 'src/a.ts:1');
});
check('plain text is not scanned for paths', () =>
  assert.deepEqual(kinds('see src/a.ts here'), ['text']));
check('text content is preserved verbatim', () =>
  assert.equal(inlineToText(inlines(decorate('`src/a.ts:42`'))), 'src/a.ts:42'));

console.log('\n4. resolution boundary');
check('inside resolves', () => assert.equal(resolveInWorkspace('src/a.ts', deps), '/ws/src/a.ts'));
check('outside is refused', () => assert.equal(resolveInWorkspace('/etc/passwd', deps), null));
check('traversal is refused', () => assert.equal(resolveInWorkspace('../x/a.ts', deps), null));
check('absolute inside the workspace resolves', () =>
  assert.equal(resolveInWorkspace('/ws/README.md', deps), '/ws/README.md'));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
