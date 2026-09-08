// test/acp-client.mjs — transport-level failure paths that need no dsh binary.
//
// Regression guards for the AcpClient hardening:
//  1. A failed spawn (ENOENT/EACCES) must settle pending calls promptly — before
//     the fix, nothing cleared the child after a spawn 'error', so stop() burned
//     two 1.5s waitForExit timeouts and later writes hung or threw.
//  2. Writing to a dead child's stdin must never throw (streams swallow EPIPE via
//     error listeners instead of raising an uncaught 'error').
import { AcpClient, windowsCommandLine } from '../out/acp/client.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

let failures = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { failures++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

console.log('\n1. a failed spawn settles promptly');
const client = new AcpClient({
  command: '/nonexistent/dsh-xyz-12345',
  args: ['--profile', 'acp'],
  cwd: tmpdir(),
  log: () => {},
});
let exitReported = 'never';
client.on('exit', (code) => { exitReported = code; });

client.start();
await check('a pending request rejects (does not hang)', async () => {
  await assert.rejects(() => client.request('initialize'), /ENOENT|running|exited/i);
});
await check('exit is reported as if the agent had exited', () => assert.equal(exitReported, null));
await check('the client no longer considers itself running', () => assert.equal(client.running, false));

console.log('\n2. writing after death neither throws nor hangs');
await check('request after the failure rejects immediately', async () => {
  await assert.rejects(() => client.request('anything'), /not running/i);
});
await check('notify after the failure is a silent no-op', () => {
  assert.doesNotThrow(() => client.notify('session/cancel', { sessionId: 'x' }));
});
await check('stop() after the failure returns immediately', async () => {
  const t0 = Date.now();
  await client.stop();
  assert.ok(Date.now() - t0 < 1000, `stop took ${Date.now() - t0}ms`);
});

console.log('\n3. windows .cmd shim command line');
await check('quotes each token for cmd.exe /c', () => {
  assert.equal(windowsCommandLine('C:\\Program Files\\dsh\\dsh.cmd', ['--profile', 'acp']),
    '"C:\\Program Files\\dsh\\dsh.cmd" "--profile" "acp"');
});
await check('doubles embedded quotes (the only cmd escaping)', () => {
  assert.equal(windowsCommandLine('dsh.cmd', ['--profile', 'a"b']),
    '"dsh.cmd" "--profile" "a""b"');
});

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
