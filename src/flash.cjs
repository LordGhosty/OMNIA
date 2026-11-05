const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
function taskFor(value) {
  if (typeof value === 'string') {
    if (value.length > 20000) throw Error('Task is too large.');
    try {
      value = JSON.parse(value);
    } catch {
      throw Error('Choose an OMNIA task JSON file.');
    }
  }
  if (
    !value ||
    value.schema !== 1 ||
    !['win32', 'linux', 'darwin'].includes(value.platform) ||
    typeof value.script !== 'string' ||
    !value.script.trim() ||
    value.script.length > 12000 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 80
  )
    throw Error('Invalid Automatic Flash task.');
  return {
    schema: 1,
    name: value.name.trim(),
    platform: value.platform,
    script: value.script.replace(/\r\n/g, '\n'),
  };
}
const fingerprint = (task) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(taskFor(task)))
    .digest('hex');
function runTask(value, { directory, platform = process.platform, spawnFn = spawn } = {}) {
  const task = taskFor(value);
  if (task.platform !== platform) throw Error('This task targets a different operating system.');
  const executable =
    platform === 'win32'
      ? path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        )
      : '/bin/sh';
  const args =
    platform === 'win32'
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(task.script, 'utf16le').toString('base64'),
        ]
      : ['-c', task.script];
  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, args, {
      cwd: directory,
      windowsHide: true,
      detached: platform !== 'win32',
      env: { ...process.env, OMNIA_FLASH_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      timedOut = false;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => (output = (output + chunk).slice(-64000)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (platform === 'win32') {
        const killer = spawnFn(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill();
        }
      }
    }, 60000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Error('Automatic Flash task exceeded its 60-second limit.'));
      else if (code !== 0)
        reject(Error('Task exited with code ' + code + '. ' + output.slice(-2000)));
      else resolve({ ok: true, message: 'Automatic Flash: ' + task.name + ' completed.', output });
    });
  });
}
module.exports = { taskFor, fingerprint, runTask };
