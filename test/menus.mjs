// test/menus.mjs — the editor-title `when` clauses.
//
// These guards are easy to get wrong and fail silently: a bad clause throws no
// error, it just makes icons appear in the wrong group or blink with focus. Both
// symptoms were observed, so the rules are pinned here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const menus = pkg.contributes.menus;
const title = menus['editor/title'];
const byCommand = (loc, cmd) => loc.find((m) => m.command === cmd);

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const PANEL_ACTIONS = [
  'dshAgent.newSession', 'dshAgent.focus', 'dshAgent.pickModel',
  'dshAgent.cancel', 'dshAgent.showLogs', 'dshAgent.restart',
];

console.log('\n1. session-panel actions stay on the session tab');
for (const cmd of PANEL_ACTIONS) {
  check(`${cmd} is present`, () => assert.ok(byCommand(title, cmd), 'missing from editor/title'));
  check(`${cmd} requires our panel to be active`, () =>
    assert.match(byCommand(title, cmd).when, /activeWebviewPanelId == 'dshAgent\.chatPanel'/));
  // activeWebviewPanelId is GLOBAL: without this clause the action renders in every
  // group's title bar, which is how the icons ended up over the code editor.
  check(`${cmd} is also scoped to a webview title bar`, () =>
    assert.match(byCommand(title, cmd).when, /resourceScheme == 'webview-panel'/));
}
check('cancel additionally requires a turn in flight', () =>
  assert.match(byCommand(title, 'dshAgent.cancel').when, /dshAgent\.busy/));

console.log('\n2. the whale does not blink with focus');
const whale = byCommand(title, 'dshAgent.openLast');
check('it is present', () => assert.ok(whale));
check('it shows on ordinary file editors', () =>
  assert.match(whale.when, /resourceScheme != 'webview-panel'/));
// Keying it off what is *active* made it vanish from the code group the moment a
// session tab took focus, and reappear on the way back.
check('it does not depend on which panel is active', () =>
  assert.ok(!/activeWebviewPanelId/.test(whale.when), `when = ${whale.when}`));

console.log('\n3. no action leaks into unrelated title bars');
check('every editor/title entry carries a when clause', () =>
  assert.ok(title.every((m) => typeof m.when === 'string' && m.when.trim() !== '')));
check('the context menu entries are panel-scoped too', () =>
  assert.ok(menus['editor/title/context'].every((m) => /resourceScheme == 'webview-panel'/.test(m.when))));

console.log('\n4. every referenced command exists');
const declared = new Set(pkg.contributes.commands.map((c) => c.command));
check('all menu commands are declared', () => {
  const missing = Object.values(menus).flat().map((m) => m.command).filter((c) => !declared.has(c));
  assert.deepEqual(missing, []);
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
