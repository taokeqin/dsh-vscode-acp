// test/composer-keys.mjs — Enter handling, and the IME case behind the
// "last word left in the box after sending" bug.
//
// An input method uses Enter to accept a candidate. That keydown arrives with
// isComposing set and BEFORE the text is committed, so sending on it shipped the
// message and then let the IME commit the accepted word into the emptied box.
import { shouldSubmit, menuHandlesKey } from '../out/composerKeys.js';
import { chatHtml } from '../out/panel/html.js';
import assert from 'node:assert/strict';

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. plain typing');
check('Enter sends', () => assert.equal(shouldSubmit({ key: 'Enter' }), true));
check('Shift+Enter does not', () => assert.equal(shouldSubmit({ key: 'Enter', shiftKey: true }), false));
check('other keys do not', () => assert.equal(shouldSubmit({ key: 'a' }), false));

console.log('\n2. while an IME is composing');
check('Enter accepting a candidate must not send', () =>
  assert.equal(shouldSubmit({ key: 'Enter', isComposing: true }), false));
check('the legacy keyCode 229 signal is honoured too', () =>
  assert.equal(shouldSubmit({ key: 'Enter', keyCode: 229 }), false));
check('Enter after composition ends does send', () =>
  assert.equal(shouldSubmit({ key: 'Enter', isComposing: false }), true));

console.log('\n3. the slash menu defers to the IME as well');
check('menu ignores keys during composition', () =>
  assert.equal(menuHandlesKey({ key: 'ArrowDown', isComposing: true }), false));
check('and keyCode 229', () => assert.equal(menuHandlesKey({ key: 'Enter', keyCode: 229 }), false));
check('but handles them otherwise', () => assert.equal(menuHandlesKey({ key: 'ArrowDown' }), true));

console.log('\n4. the panel ships these functions and no Skills button');
const html = chatHtml('n');
check('both decisions are injected', () => {
  assert.ok(html.includes('function shouldSubmit'));
  assert.ok(html.includes('function menuHandlesKey'));
});
check('composition listeners are wired', () => {
  assert.ok(html.includes('compositionstart'));
  assert.ok(html.includes('compositionend'));
});
check('the toolbar Skills button is gone — slash is the entry point', () =>
  assert.ok(!/id="skills"/.test(html)));

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
