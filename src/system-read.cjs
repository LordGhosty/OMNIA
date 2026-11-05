const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
async function readScript(name, args = []) {
  const script = await fs.readFile(path.join(__dirname, name), 'utf8');
  return readSource(script, args);
}
function readSource(script, args = []) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) =>
    execFile(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded, ...args],
      { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error)
          return reject(Error('Windows could not read this information. ' + error.message));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '')));
        } catch {
          reject(Error('Windows returned unreadable information.'));
        }
      },
    ),
  );
}
module.exports = { readScript, readSource };
