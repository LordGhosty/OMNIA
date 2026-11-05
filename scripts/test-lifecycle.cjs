const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const packaged = process.argv.includes('--packaged');
  const executable = packaged
    ? path.resolve('release/win-unpacked/OMNIA.exe')
    : require('electron');
  const env = { ...process.env, OMNIA_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const results = [];
  for (const mode of ['home', 'cached', 'active', 'transition', 'loading', 'destroyed', 'active']) {
    const started = Date.now();
    const child = spawn(executable, packaged ? [] : ['.'], {
      cwd: process.cwd(),
      env: { ...env, OMNIA_LIFECYCLE_SMOKE: mode },
      stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Close/reopen timed out: ' + mode));
      }, 30000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(Error('Lifecycle exit ' + code + ': ' + mode));
      });
    });
    const file = path.join('.qa', 'lifecycle-' + mode + '.json');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      (await fs.stat(file)).mtimeMs < started ||
      report.pid !== child.pid ||
      report.error ||
      !['ready', 'closed', 'late-second-instance', 'will-quit'].every((phase) =>
        report.phases.includes(phase),
      )
    )
      throw Error('Incomplete lifecycle check: ' + JSON.stringify(report));
    results.push(report);
    console.log('Closed and exited: ' + mode);
  }
  await fs.writeFile(
    path.join('.qa', packaged ? 'packaged-lifecycle.json' : 'lifecycle.json'),
    JSON.stringify(results, null, 2),
  );
  console.log('Seven successive launches and exits passed.');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
