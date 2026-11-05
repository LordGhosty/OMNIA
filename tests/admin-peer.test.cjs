const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  net = require('node:net'),
  crypto = require('node:crypto');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
test(
  'Windows privileged pipe verifies the core process identity',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async () => {
    const prefix = fs
      .readFileSync(path.join(__dirname, '../src/admin-worker.ps1'), 'utf8')
      .split('$reader=')[0];
    for (const parent of [process.pid, 2147483647]) {
      const name = 'omnia-peer-fixture-' + crypto.randomUUID();
      let socket;
      const server = net.createServer((s) => {
        socket = s;
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen('\\\\.\\pipe\\' + name, resolve);
      });
      try {
        const script =
          prefix.replaceAll('__PIPE__', name).replaceAll('__PARENT__', String(parent)) +
          "\n$pipe.Dispose();[Console]::Write('verified')";
        const run = promisify(execFile)(
          path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          { windowsHide: true, timeout: 15000 },
        );
        if (parent === process.pid) assert.equal((await run).stdout, 'verified');
        else await assert.rejects(run, /unexpected owner/);
      } finally {
        socket?.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  },
);
