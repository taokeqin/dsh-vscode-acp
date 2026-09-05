// test/slash-menu.mjs — the composer's slash trigger and filtering.
//
// These functions are injected into the panel script verbatim, so what runs in the
// webview is what is exercised here.
import { slashTrigger, filterSkills } from '../out/slashMenu.js';
import { chatHtml } from '../out/panel/html.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };
const at = (s) => slashTrigger(s, s.length);

console.log('\n1. when the menu opens');
check('a slash at the start of the input', () => assert.deepEqual(at('/'), { query: '', from: 0 }));
check('with a partial name', () => assert.deepEqual(at('/lon'), { query: 'lon', from: 0 }));
check('at the start of a later line', () => {
  const v = 'first line\n/long';
  assert.deepEqual(slashTrigger(v, v.length), { query: 'long', from: 11 });
});
check('hyphens and digits are part of the name', () =>
  assert.equal(at('/find-skills2').query, 'find-skills2'));

console.log('\n2. when it must stay shut');
check('a path mid-sentence does not trigger', () => assert.equal(at('see src/index.ts'), null));
check('"and/or" does not trigger', () => assert.equal(at('this and/or that'), null));
check('a slash after text on the same line does not trigger', () => assert.equal(at('hello /lo'), null));
check('a space after the name closes it', () => assert.equal(at('/longbridge '), null));
check('empty input', () => assert.equal(at(''), null));

console.log('\n3. caret position matters, not just the text');
check('caret before the slash does not trigger', () => assert.equal(slashTrigger('/long', 0), null));
check('caret inside the name uses only the text before it', () =>
  assert.deepEqual(slashTrigger('/longbridge', 5), { query: 'long', from: 0 }));
check('an out-of-range caret is clamped', () => assert.deepEqual(slashTrigger('/ab', 999), { query: 'ab', from: 0 }));

console.log('\n4. filtering');
const skills = [{ name: 'find-skills' }, { name: 'longbridge' }, { name: 'colonoscopy' }];
check('empty query offers everything', () => assert.equal(filterSkills(skills, '').length, 3));
check('prefix matches rank above substring matches', () =>
  assert.deepEqual(filterSkills(skills, 'lo').map((s) => s.name), ['longbridge', 'colonoscopy']));
check('case-insensitive', () => assert.equal(filterSkills(skills, 'LONG')[0].name, 'longbridge'));
check('no match yields nothing', () => assert.equal(filterSkills(skills, 'zzz').length, 0));
check('the input array is not mutated', () => {
  filterSkills(skills, 'lo');
  assert.equal(skills[0].name, 'find-skills');
});

console.log('\n5. the panel ships these exact functions');
const html = chatHtml('n');
check('both are injected into the script', () => {
  assert.ok(html.includes('function slashTrigger'), 'slashTrigger missing');
  assert.ok(html.includes('function filterSkills'), 'filterSkills missing');
});
check('the placeholder is fully substituted', () => assert.ok(!html.includes('__SLASH_LOGIC__')));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
