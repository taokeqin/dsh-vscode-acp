// test/gui-launch.mjs — the Dock-launched VS Code case, end to end.
//
// Regression guard for two failures that looked different but share a cause:
//   spawn dsh ENOENT                       — we could not find dsh
//   env: node: No such file or directory   — dsh could not find node (exit 127)
//
// Both come from the system PATH a GUI-launched app inherits. This test rebuilds
// that PATH and drives a real handshake through it, which is the only way to catch
// the second failure: locating the file says nothing about being able to exec it.
import { AcpConnection } from '../out/acp/connection.js';
import { locateDsh, childPathFor } from '../out/acp/locate.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

/** The literal PATH a Dock-launched app gets on macOS — no version manager on it. */
const GUI_PATH = '/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin';

let failures = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const realPath = process.env.PATH;
process.env.PATH = GUI_PATH;

console.log('\n1. discovery under the GUI PATH');
const found = locateDsh('');
console.log(`   → ${found ? `${found.path} (via ${found.via})` : 'null'}`);
await check('dsh is still found', () => assert.ok(found));

console.log('\n2. the child PATH can reach the runtime');
const childPath = childPathFor(found.path);
await check('node is reachable from the child PATH', () => {
  const hasNode = childPath.split(':').some((d) => {
    try { return existsSync(join(d, 'node')); } catch { return false; }
  });
  assert.ok(hasNode, `no node in ${childPath.split(':').slice(0, 3).join(':')}…`);
});
await check('the inherited PATH is preserved, not replaced', () =>
  assert.ok(childPath.endsWith(GUI_PATH)));

console.log('\n3. a real handshake through that PATH');
const ws = mkdtempSync(join(tmpdir(), 'dsh-gui-'));
const conn = new AcpConnection({
  command: '', profile: 'acp', cwd: ws,
  log: (l) => process.env.VERBOSE && console.log('   ' + l),
  onExit: () => {},
  onPermission: async () => null,
});
await check('the agent starts and handshakes (would exit 127 before the fix)', async () => {
  await conn.ensureStarted();
  assert.match(conn.agentName, /deepseek-harness-acp/);
});
await check('a session can be created', async () => {
  const id = await conn.newSession();
  assert.ok(id);
});
await conn.dispose();

process.env.PATH = realPath;
console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
