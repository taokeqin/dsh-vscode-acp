// test/menus.mjs — the editor-title contribution, and where session actions live.
//
// Session actions were tried in editor/title and did not work: those menus are
// scoped by activeWebviewPanelId, a GLOBAL key, so they rendered over every group,
// and keying the whale off it made it blink with focus. They now live inside the
// webview header. This file pins that split, because a wrong `when` clause raises no
// error — it just makes the UI misbehave.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chatHtml } from '../out/panel/html.js';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const menus = pkg.contributes.menus;
const title = menus['editor/title'];

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const PANEL_ACTIONS = ['dshAgent.newSession', 'dshAgent.focus', 'dshAgent.pickModel', 'dshAgent.cancel'];

console.log('\n1. the editor title bar carries only the whale');
check('exactly one entry', () => assert.equal(title.length, 1));
check('and it is DSH: Open', () => assert.equal(title[0].command, 'dshAgent.openLast'));
check('shown on ordinary file editors', () =>
  assert.match(title[0].when, /resourceScheme != 'webview-panel'/));
// Keying it off what is active made it vanish from the code group the moment a
// session tab took focus, and reappear on the way back.
check('and never keyed off which panel is active', () =>
  assert.ok(!/activeWebviewPanelId/.test(title[0].when), `when = ${title[0].when}`));

console.log('\n2. session actions are not in any editor menu');
for (const cmd of PANEL_ACTIONS) {
  check(`${cmd} is absent from editor/title`, () =>
    assert.ok(!title.some((m) => m.command === cmd)));
}
check('editor/title/context is gone entirely', () =>
  assert.equal(menus['editor/title/context'], undefined));
check('no menu anywhere depends on activeWebviewPanelId', () => {
  const leaks = Object.values(menus).flat().filter((m) => /activeWebviewPanelId/.test(m.when ?? ''));
  assert.deepEqual(leaks.map((m) => m.command), []);
});

console.log('\n3. the panel header provides them instead');
const html = chatHtml('n');
check('the header exists', () => assert.match(html, /id="head"/));
check('a New button', () => assert.match(html, /id="btn-new"/));
check('a History button', () => assert.match(html, /id="btn-sessions"/));
check('both post a message rather than relying on a menu', () => {
  assert.match(html, /type: 'newSession'/);
  assert.match(html, /type: 'showSessions'/);
});

console.log('\n4. commands stay reachable from the palette');
const declared = new Set(pkg.contributes.commands.map((c) => c.command));
for (const cmd of PANEL_ACTIONS) {
  check(`${cmd} is still declared`, () => assert.ok(declared.has(cmd)));
}
check('all menu commands are declared', () => {
  const missing = Object.values(menus).flat().map((m) => m.command).filter((c) => !declared.has(c));
  assert.deepEqual(missing, []);
});
check('the sidebar view keeps its own actions', () =>
  assert.ok(menus['view/title'].length > 0));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
