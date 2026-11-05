const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  if (process.platform !== 'win32') throw Error('This packaged check requires Windows.');
  const started = Date.now();
  const report = path.resolve('.qa/packaged-smoke.json');
  const env = { ...process.env, OMNIA_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('release/win-unpacked/OMNIA.exe'), [], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Detached terminal regression: the app must survive closed output pipes.
  child.stdout.destroy();
  child.stderr.destroy();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('Packaged check timed out.'));
    }, 300000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(Error('Packaged check exited with ' + code));
    });
  });
  const fresh = await fs
    .stat(report)
    .then((stat) => stat.mtimeMs >= started)
    .catch(() => false);
  if (!fresh) {
    const diagnostic = path.resolve('.qa/packaged-smoke-error.txt');
    if (
      await fs
        .stat(diagnostic)
        .then((stat) => stat.mtimeMs >= started)
        .catch(() => false)
    )
      throw Error(await fs.readFile(diagnostic, 'utf8'));
    throw Error('No fresh packaged report.');
  }
  const result = JSON.parse(await fs.readFile(report, 'utf8'));
  if (
    !result.toolRecovery?.rendererHang ||
    !result.workbench?.metadataNotes ||
    !result.fileTools?.rename?.undo
  )
    throw Error('Packaged checks did not complete.');
  console.log('Packaged conversions, file workflows, navigation and fault isolation passed.');
}
run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
