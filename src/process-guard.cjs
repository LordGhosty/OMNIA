const { spawn } = require('node:child_process');

/** Attaches the backend before initialization; closing the guard ends its process tree. */
function guardProcess(
  executable,
  pid,
  { parent = process.pid, memoryMB = 2048, onExit = () => {} } = {},
) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(pid) || pid < 1) return reject(Error('Invalid tool process.'));
    const child = spawn(executable, [String(parent), String(pid), String(memoryMB)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false,
      closed = false,
      output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('Process containment timed out.'));
    }, 10000);
    const fail = () => {
      clearTimeout(timeout);
      reject(Error('Windows could not contain this tool process.'));
    };
    child.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-128);
      if (!ready && output.includes('READY')) {
        ready = true;
        clearTimeout(timeout);
        resolve({
          close() {
            closed = true;
            child.kill();
          },
        });
      }
    });
    child.on('exit', () => {
      if (!ready) fail();
      else if (!closed) onExit();
    });
  });
}
module.exports = { guardProcess };
