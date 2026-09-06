// test/panel-column.mjs — where a new session tab lands.
//
// Guards the bug where every new or reopened session split the editor into another
// group: Beside means "next to whatever is active", so opening a session from a
// session tab kept creating columns instead of adding tabs.
import { pickSessionColumn } from '../out/panelColumn.js';
import assert from 'node:assert/strict';

const BESIDE = -2; // vscode.ViewColumn.Beside
let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. first session tab');
check('no tabs open → the configured column, group not yet ours', () =>
  assert.deepEqual(pickSessionColumn(undefined, [], BESIDE), { column: BESIDE, reused: false }));

console.log('\n2. opening a session while another session tab is focused');
check('joins the focused tab\'s group, not a new one', () =>
  assert.deepEqual(pickSessionColumn(2, [2], BESIDE), { column: 2, reused: true }));
check('this is the regression: never returns Beside here', () =>
  assert.notEqual(pickSessionColumn(2, [2], BESIDE).column, BESIDE));
check('reused is what stops the group being locked twice', () =>
  assert.equal(pickSessionColumn(2, [2], BESIDE).reused, true));

console.log('\n3. session tabs open but code is focused');
check('joins the existing session group', () =>
  assert.deepEqual(pickSessionColumn(undefined, [3], BESIDE), { column: 3, reused: true }));
check('hidden panels report no column and are skipped', () =>
  assert.equal(pickSessionColumn(undefined, [undefined, undefined, 2], BESIDE).column, 2));
check('all hidden → falls back to the configured column, unreused', () =>
  assert.deepEqual(pickSessionColumn(undefined, [undefined, undefined], BESIDE), { column: BESIDE, reused: false }));

console.log('\n4. several groups');
check('the focused group wins over other open ones', () =>
  assert.equal(pickSessionColumn(3, [2, 3, 4], BESIDE).column, 3));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
