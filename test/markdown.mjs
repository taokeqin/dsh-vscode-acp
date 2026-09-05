// test/markdown.mjs — the Markdown subset, including the real agent output that
// exposed the problem (bold, inline code and headings rendered as literal text).
import { parseMarkdown, parseInline, inlineToText } from '../out/markdown.js';
import { loadTranscript, summariseToolArgs } from '../out/history/store.js';
import { chatHtml } from '../out/panel/html.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let failures = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const kinds = (b) => b.map((x) => x.t).join(',');

console.log('\n1. blocks');
await check('heading level and text', () => {
  const [h] = parseMarkdown('## 核心思路');
  assert.equal(h.t, 'h'); assert.equal(h.level, 2);
  assert.equal(inlineToText(h.v), '核心思路');
});
await check('fenced code keeps its body verbatim', () => {
  const [c] = parseMarkdown('```ts\nconst a = **1**;\n```');
  assert.equal(c.t, 'code'); assert.equal(c.lang, 'ts');
  assert.equal(c.v, 'const a = **1**;');
});
await check('an unterminated fence still closes (streaming)', () => {
  const [c] = parseMarkdown('```\nhalf a message');
  assert.equal(c.t, 'code'); assert.equal(c.v, 'half a message');
});
await check('bullet list', () => {
  const [l] = parseMarkdown('- one\n- two');
  assert.equal(l.t, 'ul'); assert.equal(l.items.length, 2);
  assert.equal(inlineToText(l.items[1]), 'two');
});
await check('ordered list keeps its start', () => {
  const [l] = parseMarkdown('3. third\n4. fourth');
  assert.equal(l.t, 'ol'); assert.equal(l.start, 3);
});
await check('blockquote and rule', () =>
  assert.equal(kinds(parseMarkdown('> quoted\n\n---')), 'quote,hr'));
await check('paragraphs split on blank lines', () =>
  assert.equal(kinds(parseMarkdown('one\n\ntwo')), 'p,p'));

console.log('\n2. inline');
await check('bold', () => {
  const n = parseInline('a **b** c');
  assert.equal(n[1].t, 'strong'); assert.equal(inlineToText(n[1].v), 'b');
});
await check('inline code', () => {
  const n = parseInline('run `dsh web` now');
  assert.equal(n[1].t, 'code'); assert.equal(n[1].v, 'dsh web');
});
await check('code binds tighter than bold', () => {
  // Without this, a snippet containing ** would turn half the message bold.
  const n = parseInline('`a ** b`');
  assert.equal(n.length, 1); assert.equal(n[0].t, 'code');
});
await check('italic does not fire inside a word', () =>
  assert.equal(parseInline('snake_case_name').every((x) => x.t === 'text'), true));
await check('http link', () => {
  const n = parseInline('[docs](https://example.com)');
  assert.equal(n[0].t, 'link'); assert.equal(n[0].href, 'https://example.com');
});
await check('non-http link stays literal, never a live href', () => {
  const n = parseInline('[x](javascript:alert(1))');
  assert.ok(n.every((x) => x.t === 'text'));
  assert.equal(inlineToText(n), '[x](javascript:alert(1))');
});
await check('unmatched markers stay literal', () =>
  assert.equal(inlineToText(parseInline('2 * 3 * 4')), '2 * 3 * 4'));

console.log('\n3. real agent output from this workspace');
const r = await loadTranscript({
  dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  sessionId: '6ec36fa3-c8d3-4fa7-b535-a0d57604c527',
  cwd: '/Users/hacken/Code/dsh-vscode-acp',
  maxEntries: 20,
});
if (r.ok && r.entries.some((e) => e.kind === 'assistant' && e.text.includes('**'))) {
  const msg = r.entries.find((e) => e.kind === 'assistant' && e.text.includes('**'));
  const blocks = parseMarkdown(msg.text);
  console.log(`  (${blocks.length} blocks: ${[...new Set(blocks.map(b => b.t))].join(', ')})`);
  await check('produces structure, not one raw paragraph', () => assert.ok(blocks.length > 1));
  await check('the heading became a heading', () => assert.ok(blocks.some((b) => b.t === 'h')));
  await check('no literal ** survives in text nodes', () => {
    const flat = blocks.filter((b) => b.v && Array.isArray(b.v)).map((b) => inlineToText(b.v)).join('');
    assert.ok(!flat.includes('**'), 'raw ** still present');
  });
} else {
  console.log('  (no markdown sample on disk; skipped)');
}

console.log('\n4. tool argument summaries');
await check('bash shows its command, not the JSON blob', () =>
  assert.equal(summariseToolArgs('{"command":"ls -la /tmp","description":"list"}'), 'ls -la /tmp'));
await check('a file tool shows its path', () =>
  assert.equal(summariseToolArgs('{"file_path":"/a/b.ts"}'), '/a/b.ts'));
await check('falls back to the first string field', () =>
  assert.equal(summariseToolArgs('{"weird":42,"other":"value"}'), 'value'));
await check('non-JSON is shown as-is', () => assert.equal(summariseToolArgs('plain text'), 'plain text'));
await check('empty in, empty out', () => assert.equal(summariseToolArgs(''), ''));
await check('newlines collapse for a one-line row', () =>
  assert.equal(summariseToolArgs('{"command":"a\\nb"}'), 'a b'));

console.log('\n5. the webview script parses');
// It ships as a string inside the HTML, so tsc never sees it; a syntax error would
// only surface as a blank panel at runtime.
await check('inline script is syntactically valid JS', () => {
  const html = chatHtml('test-nonce');
  const scripts = [...html.matchAll(/<script nonce="test-nonce">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'no inline script found');
  for (const src of scripts) new Function(src); // throws on a syntax error
});
await check('the panel never assigns markup', () => {
  // Everything rendered is agent output, so it must go through createElement and
  // textContent only. Matches property *use* (leading dot) rather than the bare
  // word, which also appears in comments explaining why it is avoided.
  const html = chatHtml('n');
  const hit = /\.(innerHTML|outerHTML|insertAdjacentHTML)\b/.exec(html);
  assert.equal(hit, null, hit ? `found ${hit[0]}` : '');
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
