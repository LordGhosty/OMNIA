const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const allowed = new Set([
  'flush-dns',
  'register-dns',
  'renew-dhcp',
  'restart-adapter',
  'dns-cloudflare',
  'dns-google',
  'dns-auto',
  'drive-label',
  'drive-letter',
  'drive-format',
  'drive-reset',
  'driver-list',
  'driver-backup',
  'driver-remove',
  'firewall-list',
  'firewall-detail',
  'firewall-change',
  'repair-run',
]);
const ps = () =>
  path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function workerScript(pipe, token, parent) {
  return fs
    .readFileSync(path.join(__dirname, 'admin-worker.ps1'), 'utf8')
    .replace('__DRIVER_ACTIONS__', () =>
      ['driver-admin.ps1', 'firewall-commands.ps1', 'repair-commands.ps1']
        .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
        .join('\n'),
    )
    .replaceAll('__PIPE__', pipe)
    .replaceAll('__TOKEN__', token)
    .replaceAll('__PARENT__', String(parent));
}
function launchScript(script) {
  const packed = require('node:zlib').gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  return `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}'));$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);try{$s=$r.ReadToEnd()}finally{$r.Dispose();$g.Dispose();$m.Dispose()};& ([ScriptBlock]::Create($s))`;
}
/** Owns one elevated helper session; only fixed, allowlisted operations cross its pipe. */
function createAdmin({ onChange = () => {}, launch } = {}) {
  let socket,
    receiver,
    connecting,
    pending,
    state = 'off',
    closing = false;
  const status = () => ({
    state,
    enabled: state === 'on',
    supported: process.platform === 'win32',
    busy: !!pending,
  });
  const change = (value) => {
    state = value;
    onChange(status());
  };
  function disconnect() {
    socket?.destroy();
    socket = null;
    receiver?.close();
    receiver = null;
    if (pending) {
      pending.reject(
        Error('Administrator session disconnected. Refresh the operation result before retrying.'),
      );
      pending = null;
    }
    change('off');
  }
  async function enable() {
    if (process.platform !== 'win32')
      throw Error('Administrator sessions are currently available on Windows.');
    if (socket) return status();
    if (connecting) return connecting;
    connecting = (async () => {
      closing = false;
      change('requesting');
      const pipe = 'omnia-admin-' + crypto.randomUUID(),
        token = crypto.randomBytes(32).toString('hex');
      const script = launchScript(workerScript(pipe, token, process.pid)),
        encoded = Buffer.from(script, 'utf16le').toString('base64');
      const command = `try{Start-Process -FilePath ${quote(ps())} -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -ErrorAction Stop | Out-Null}catch{exit 1}`;
      if (command.length > 30000) throw Error('Administrator helper is too large to launch.');
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            disconnect();
            reject(error);
          } else {
            change('on');
            resolve();
          }
        };
        const timer = setTimeout(() => finish(Error('Administrator permission timed out.')), 90000);
        receiver = net.createServer((candidate) => {
          let buffer = '',
            authenticated = false;
          candidate.setEncoding('utf8');
          candidate.setTimeout(5000);
          candidate.on('timeout', () => candidate.destroy());
          candidate.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > (authenticated ? 8 * 1024 * 1024 : 32768)) {
              candidate.destroy();
              return;
            }
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              let data;
              try {
                data = JSON.parse(line);
              } catch {
                candidate.destroy();
                return;
              }
              if (!authenticated) {
                if (data.hello !== token || socket || closing) {
                  candidate.destroy();
                  return;
                }
                if (!data.elevated && !launch) {
                  candidate.destroy();
                  finish(Error('The helper did not receive administrator permission.'));
                  return;
                }
                authenticated = true;
                candidate.setTimeout(0);
                socket = candidate;
                finish();
              } else if (pending && data.id === pending.id) {
                if (typeof data.progress === 'string') {
                  pending.onProgress?.(data.progress);
                  continue;
                }
                const task = pending;
                pending = null;
                data.ok
                  ? task.resolve(data)
                  : task.reject(Error(data.error || 'Administrator action failed.'));
              }
            }
          });
          candidate.on('error', () => {});
          candidate.on('close', () => {
            if (socket === candidate) disconnect();
          });
        });
        receiver.once('error', finish);
        receiver.listen('\\\\.\\pipe\\' + pipe, () => {
          const child = launch
            ? launch(script)
            : spawn(ps(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
                windowsHide: true,
                stdio: 'ignore',
              });
          child.once('error', finish);
          child.once('exit', (code) => {
            if (code !== 0) finish(Error('Administrator permission was declined or unavailable.'));
          });
        });
      });
      return status();
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
      if (!socket) change('off');
    }
  }
  async function run(action, data, onProgress) {
    if (!allowed.has(action)) throw Error('Unsupported administrator action.');
    if (!socket) throw Error('Enable the administrator shield first.');
    if (pending) throw Error('An administrator operation is already running.');
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending = { id, resolve, reject, onProgress };
      socket.write(JSON.stringify({ id, action, data }) + '\n', (error) => {
        if (error) disconnect();
      });
    });
  }
  function disable() {
    if (pending) throw Error('Wait for the administrator operation to finish.');
    closing = true;
    if (socket) socket.end(JSON.stringify({ action: 'shutdown' }) + '\n');
    disconnect();
    return status();
  }
  return { status, enable, disable, run, close: disable };
}
module.exports = { createAdmin, workerScript, launchScript, allowed };
