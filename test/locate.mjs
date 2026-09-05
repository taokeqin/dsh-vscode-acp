// test/locate.mjs — executable discovery, including the GUI-launch PATH case that
// produced `spawn dsh ENOENT` in a Dock-launched VS Code.
import { locateDsh, notFoundMessage } from '../out/acp/locate.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import assert from 'node:assert/strict';

const realDeps = () => ({
  exists: (p) => fs.existsSync(p),
  readdir: (p) => fs.readdirSync(p),
  loginShell: () => { throw new Error('login shell not expected in this test'); },
  env: process.env,
  home: os.homedir(),
});

let failures = 0;
const check = (n, fn) => { try { fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. GUI-launched VS Code: system PATH with no version manager');
// The literal default PATH a Dock-launched app gets on this machine.
const guiEnv = { PATH: '/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin', SHELL: '/bin/zsh' };
const r1 = locateDsh('', { ...realDeps(), env: guiEnv });
console.log(`   → ${r1 ? `${r1.path}  (via ${r1.via})` : 'null'}`);
check('still finds dsh', () => assert.ok(r1 && r1.path.endsWith('/dsh')));
check('resolved without spawning a shell', () => assert.equal(r1.via, 'well-known'));

console.log('\n2. terminal-launched VS Code: nvm already on PATH');
const r2 = locateDsh('', realDeps());
check('uses the PATH branch', () => assert.equal(r2?.via, 'PATH'));

console.log('\n3. explicit dshAgent.executablePath');
check('an absolute path is taken as-is', () => {
  const r = locateDsh(r1.path, realDeps());
  assert.equal(r.via, 'setting');
  assert.equal(r.path, r1.path);
});
check('a bad absolute path returns null, not a fallback', () =>
  assert.equal(locateDsh('/nope/dsh', realDeps()), null));

console.log('\n4. nothing found anywhere');
const r4 = locateDsh('definitely-not-a-real-binary-xyz', {
  ...realDeps(),
  env: { PATH: '/nonexistent' },
  loginShell: () => { throw new Error('no shell'); },
});
check('returns null rather than throwing', () => assert.equal(r4, null));
check('the message names the setting to fix it', () =>
  assert.match(notFoundMessage(''), /dshAgent\.executablePath/));
check('a hanging login shell cannot break lookup', () => {
  const r = locateDsh('nope-xyz', {
    ...realDeps(), env: { PATH: '/nonexistent', SHELL: '/bin/zsh' },
    loginShell: () => { throw new Error('timeout'); },
  });
  assert.equal(r, null);
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
