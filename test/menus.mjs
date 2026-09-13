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

console.log('\n3b. the session list is inline, not a detour to the sidebar');
check('the panel renders its own list', () => assert.match(html, /id="sessions"/));
check('History asks the host for rows instead of focusing a view', () =>
  assert.match(html, /type: 'showSessions'/));
check('picking a row opens that session', () => assert.match(html, /type: 'openSession'/));
check('the active row is a no-op rather than a needless resume', () =>
  assert.match(html, /if \(!r\.active\)/));
check('outside click and Escape dismiss it', () => {
  assert.match(html, /closeSessions/);
  assert.match(html, /'Escape'/);
});

console.log('\n3c. the context ring sits with the settings, not against Send');
check('status area is left-aligned', () =>
  assert.match(html, /#status \{[^}]*justify-content: flex-start/));

console.log('\n3d. files are added from the in-composer @ menu and the explorer');
// No toolbar buttons: typing '@' is the composer path, the explorer right-click the
// other, and both funnel into addFilesContext.
check('there is no Files button in the composer', () => assert.ok(!html.includes('id="add-files"')));
check('typing @ asks the host for matches', () => assert.match(html, /type: 'fileQuery'/));
check('the host answers with matches', () => assert.match(html, /case 'fileMatches'/));
check('picking a match adds a context chip', () => assert.match(html, /type: 'addContextFile'/));
check('the @ trigger ships in the panel script', () => assert.match(html, /function atTrigger/));
check('the placeholder points at @', () => assert.match(html, /@ for files/));
check('explorer offers adding a file', () => {
  const entry = (menus['explorer/context'] ?? []).find((m) => m.command === 'dshAgent.addFiles');
  assert.ok(entry, 'no explorer/context entry for dshAgent.addFiles');
  assert.match(entry.when, /!explorerResourceIsFolder/);
  assert.match(entry.when, /resourceScheme == 'file'/);
});

console.log('\n3e. context is a checkbox-driven list — never implicit, never a button');
check('there is no Selection button in the composer', () => assert.ok(!html.includes('id="add-selection"')));
check('the editor menu can still toggle the selection', () =>
  assert.ok((menus['editor/context'] ?? []).some((m) => m.command === 'dshAgent.addSelection')));
check('chips render in their own strip', () => assert.match(html, /id="context"/));
check('a chip can be removed', () => assert.match(html, /type: 'removeContext'/));
check('a chip can be switched off without removing it', () =>
  assert.match(html, /type: 'toggleContext'/));
check('every chip carries a checkbox', () =>
  assert.match(html, /box\.type = 'checkbox'/));

console.log('\n4. commands stay reachable from the palette');
const declared = new Set(pkg.contributes.commands.map((c) => c.command));
for (const cmd of PANEL_ACTIONS) {
  check(`${cmd} is still declared`, () => assert.ok(declared.has(cmd)));
}
check('all menu commands are declared', () => {
  const missing = Object.values(menus).flat().map((m) => m.command).filter((c) => !declared.has(c));
  assert.deepEqual(missing, []);
});
check('the add-files command is declared', () => assert.ok(declared.has('dshAgent.addFiles')));
check('the add-selection command is declared', () => assert.ok(declared.has('dshAgent.addSelection')));
check('the sidebar view keeps its own actions', () =>
  assert.ok(menus['view/title'].length > 0));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
