const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  net = require('node:net');
const { spawn } = require('node:child_process');
const algorithms = { ed25519: [256], rsa: [2048, 3072, 4096, 8192], ecdsa: [256, 384, 521] };
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
function phrase(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value))
    throw Error('Use a passphrase of at most 512 UTF-8 bytes without control characters.');
  return value;
}
/** Validates key settings and rejects implicit unencrypted output or unsafe folder names. */
function validate(options) {
  const algorithm = options.algorithm || 'ed25519',
    bits = Number(options.bits || algorithms[algorithm]?.[0]),
    rounds = Number(options.rounds ?? 64);
  if (!algorithms[algorithm]?.includes(bits))
    throw Error('Choose a supported algorithm and key size.');
  if (!Number.isInteger(rounds) || rounds < 16 || rounds > 256)
    throw Error('Use 16–256 encryption rounds.');
  const comment = String(options.comment || '');
  if (Buffer.byteLength(comment) > 240 || /[\x00-\x1f\x7f]/.test(comment))
    throw Error('Use a single-line comment of at most 240 UTF-8 bytes.');
  const passphrase = phrase(options.passphrase ?? '');
  if (passphrase !== options.confirm) throw Error('The passphrases do not match.');
  if (!passphrase && !options.allowEmpty)
    throw Error('Enter a passphrase or explicitly choose an unencrypted key.');
  const name = String(options.name || '');
  if (
    !/^[\p{L}\p{N}_. -]{1,80}$/u.test(name) ||
    /^[. ]|[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw Error('Choose a key folder name without path characters or reserved names.');
  return { algorithm, bits, rounds, comment, passphrase, name };
}
async function run(
  executable,
  args,
  { input = '', env = {}, signal, timeout = 120000, acceptFailure = false } = {},
) {
  if (signal?.aborted) throw Error('Operation cancelled.');
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '',
      settled = false,
      reason;
    const child = spawn(executable, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const stop = () => {
      reason = 'Operation cancelled.';
      child.kill();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      reason = 'OpenSSH timed out.';
      child.kill();
    }, timeout);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      error ? reject(error) : resolve(value);
    };
    child.on('error', () => finish(Error('The local OpenSSH command could not start.')));
    child.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length > 262144) {
        reason = 'OpenSSH output exceeded the limit.';
        child.kill();
      }
    });
    child.stderr.on('data', (b) => {
      stderr += b;
      if (stderr.length > 32768) {
        reason = 'OpenSSH output exceeded the limit.';
        child.kill();
      }
    });
    child.on('close', (code) => {
      if (reason) return finish(Error(reason));
      if (code !== 0 && !acceptFailure)
        return finish(
          Error(
            'OpenSSH could not complete the operation. Check the key, passphrase and selected options.',
          ),
        );
      finish(null, { stdout, stderr, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
/** Supplies interactive secrets over stdin or a one-operation authenticated Windows pipe. */
async function withPassphrases(executable, args, secrets, { helper, signal, timeout } = {}) {
  if (process.platform !== 'win32')
    return run(executable, args, {
      input: secrets.join('\n') + '\n',
      env: { SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '', DISPLAY: '', WAYLAND_DISPLAY: '' },
      signal,
      timeout,
    });
  await fs.access(helper);
  const name = 'omnia-key-' + crypto.randomUUID(),
    token = crypto.randomBytes(32).toString('hex'),
    sockets = new Set();
  let used = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let request = '';
    socket.on('data', (b) => {
      request += b;
      if (request.length > 128) return socket.destroy();
      if (!request.includes('\n')) return;
      if (request.trim() !== token || used >= secrets.length) return socket.end('NO\n');
      const response = Buffer.from(secrets[used++], 'utf8');
      socket.end('OK:' + response.toString('base64') + '\n');
      response.fill(0);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen('\\\\.\\pipe\\' + name, resolve);
  });
  try {
    return await run(executable, args, {
      env: {
        SSH_ASKPASS_REQUIRE: 'force',
        SSH_ASKPASS: helper,
        DISPLAY: 'omnia',
        OMNIA_KEY_PIPE: name,
        OMNIA_KEY_TOKEN: token,
      },
      signal,
      timeout,
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
    secrets.fill('');
  }
}
async function permissions(directory, mode = 'check', signal) {
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
    for (const name of await fs.readdir(directory))
      await fs.chmod(path.join(directory, name), 0o600);
    return;
  }
  const script = await fs.readFile(path.join(__dirname, 'ssh-permissions.ps1'), 'utf8');
  const result = await run(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { env: { OMNIA_KEY_DIRECTORY: directory, OMNIA_KEY_ACL_MODE: mode }, signal, timeout: 15000 },
  );
  if (result.stdout.trim() !== 'OK') throw Error('Private-key permissions could not be verified.');
}
function privateCipher(text) {
  if (!text.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) return null;
  const blob = Buffer.from(
    text
      .split('\n')
      .filter((l) => !l.startsWith('---'))
      .join(''),
    'base64',
  );
  try {
    if (blob.subarray(0, 15).toString() !== 'openssh-key-v1\0' || blob.length < 19)
      throw Error('Invalid OpenSSH key.');
    const length = blob.readUInt32BE(15);
    if (length > 100 || 19 + length > blob.length) throw Error('Invalid OpenSSH key.');
    return blob.subarray(19, 19 + length).toString();
  } finally {
    blob.fill(0);
  }
}
/** Parses one OpenSSH public-key line and calculates its SHA-256 fingerprint. */
function publicLine(value) {
  const text = value.trim();
  if (text.includes('\n') || text.length > 32768) throw Error('Select one public key.');
  const parts = text.split(/\s+/);
  if (
    parts.length < 2 ||
    !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-[a-z0-9@.-]+)$/.test(parts[0]) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])
  )
    throw Error('Unsupported public-key format.');
  const blob = Buffer.from(parts[1], 'base64');
  if (
    blob.length < 8 ||
    blob.readUInt32BE(0) > 200 ||
    blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() !== parts[0]
  )
    throw Error('Invalid public-key data.');
  return {
    line: parts.join(' '),
    type: parts[0],
    fingerprint:
      'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''),
  };
}
/** Locates and probes the installed OpenSSH client without downloading executables. */
async function discover() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH/ssh-keygen.exe')]
      : ['/usr/bin/ssh-keygen', '/usr/local/bin/ssh-keygen', '/opt/homebrew/bin/ssh-keygen'];
  for (const dir of (process.env.PATH || '').split(path.delimiter))
    if (path.isAbsolute(dir))
      candidates.push(
        path.join(dir, process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'),
      );
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      const probe = await run(candidate, ['-?'], { acceptFailure: true, timeout: 5000 });
      if (!/ssh-keygen/i.test(probe.stdout + probe.stderr)) continue;
      let version = 'OpenSSH';
      try {
        const sibling = path.join(
          path.dirname(candidate),
          process.platform === 'win32' ? 'ssh.exe' : 'ssh',
        );
        const v = await run(sibling, ['-V'], { acceptFailure: true, timeout: 5000 });
        version = (v.stderr || v.stdout).trim().slice(0, 200);
      } catch {}
      return {
        available: true,
        executable: await fs.realpath(candidate),
        version,
        platform: process.platform,
      };
    } catch {}
  }
  return {
    available: false,
    platform: process.platform,
    message:
      process.platform === 'win32'
        ? 'Install OpenSSH Client in Windows Optional Features, then refresh.'
        : process.platform === 'darwin'
          ? 'Install or restore the macOS OpenSSH command-line tools, then refresh.'
          : 'Install your distribution’s OpenSSH client package, then refresh.',
  };
}
/** Converts a PEM public key to OpenSSH wire format without launching native importers. */
function publicFromPEM(text) {
  const key = crypto.createPublicKey(text).export({ format: 'jwk' });
  const field = (value) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    return Buffer.concat([size, data]);
  };
  const integer = (value) => {
    let data = Buffer.from(value, 'base64url');
    while (data.length > 1 && data[0] === 0) data = data.subarray(1);
    if (data[0] & 128) data = Buffer.concat([Buffer.from([0]), data]);
    return field(data);
  };
  let type, parts;
  if (key.kty === 'RSA') {
    type = 'ssh-rsa';
    parts = [field(type), integer(key.e), integer(key.n)];
  } else if (key.kty === 'EC') {
    const curve = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[key.crv];
    if (!curve) throw Error('Unsupported public-key curve.');
    type = 'ecdsa-sha2-' + curve;
    parts = [
      field(type),
      field(curve),
      field(
        Buffer.concat([
          Buffer.from([4]),
          Buffer.from(key.x, 'base64url'),
          Buffer.from(key.y, 'base64url'),
        ]),
      ),
    ];
  } else if (key.kty === 'OKP' && key.crv === 'Ed25519') {
    type = 'ssh-ed25519';
    parts = [field(type), field(Buffer.from(key.x, 'base64url'))];
  } else throw Error('Unsupported PEM public key.');
  return type + ' ' + Buffer.concat(parts).toString('base64');
}
/** Creates a local key service. Private bytes and passphrases never enter returned state. */
function createSSHKeys({
  helper = path.join(__dirname, '../vendor/win32/omnia-askpass.exe'),
} = {}) {
  let capability = null,
    destination = null,
    selection = null,
    result = null,
    busy = false,
    controller = null,
    phase = 'idle';
  const status = () => ({
    capability,
    destination,
    selection: selection && {
      path: selection.path,
      name: path.basename(selection.path),
      kind: selection.kind,
    },
    result,
    busy,
    phase,
  });
  async function available() {
    capability ??= await discover();
    if (!capability.available) throw Error(capability.message);
    return capability.executable;
  }
  async function refresh() {
    if (busy) throw Error('Wait for the key operation.');
    capability = await discover();
    if (capability.available && process.platform === 'win32') {
      try {
        await fs.access(helper);
      } catch {
        capability = {
          available: false,
          message: 'The SSH passphrase helper is missing. Reinstall OMNIA.',
          platform: process.platform,
        };
      }
    }
    return status();
  }
  async function selectFolder(folder) {
    if (busy) throw Error('Wait for the key operation.');
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Choose a regular folder.');
    destination = await fs.realpath(folder);
    return status();
  }
  async function selectFile(file) {
    if (busy) throw Error('Wait for the key operation.');
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 524288)
      throw Error('Choose a regular key file smaller than 512 KiB.');
    const bytes = await fs.readFile(file);
    try {
      const text = bytes.toString('utf8').trim(),
        kind = /^-----BEGIN (OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text)
          ? 'private'
          : 'public';
      try {
        if (kind === 'private') {
          const label = text.match(/^-----BEGIN (.+?)-----/)[1];
          if (!text.endsWith('-----END ' + label + '-----')) throw Error('Incomplete key.');
          privateCipher(text);
        } else if (text.startsWith('---- BEGIN SSH2 PUBLIC KEY ----')) {
          if (!text.endsWith('---- END SSH2 PUBLIC KEY ----')) throw Error('Incomplete key.');
        } else if (/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(text)) publicFromPEM(text);
        else publicLine(text);
      } catch {
        throw Error('Wrong file format. Choose an OpenSSH, PEM or RFC4716 key.');
      }
      selection = { path: await fs.realpath(file), hash: digest(bytes), kind };
      result = null;
      return status();
    } finally {
      bytes.fill(0);
    }
  }
  async function source() {
    if (!selection) throw Error('Choose a key first.');
    const s = await fs.lstat(selection.path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 524288) throw Error('Select the key again.');
    const bytes = await fs.readFile(selection.path);
    if (digest(bytes) !== selection.hash) {
      bytes.fill(0);
      throw Error('The selected key changed. Select it again.');
    }
    return bytes;
  }
  async function scratch() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-key-'));
    try {
      await permissions(dir, 'set', controller?.signal);
      return dir;
    } catch (e) {
      await fs.rmdir(dir).catch(() => {});
      throw e;
    }
  }
  async function clean(dir) {
    if (!dir) return;
    for (const name of ['key', 'key.pub', 'public', 'converted', 'converted.pub'])
      await fs.unlink(path.join(dir, name)).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
  async function operation(fn) {
    if (busy) throw Error('A key operation is already running.');
    busy = true;
    controller = new AbortController();
    try {
      await available();
      return await fn();
    } finally {
      controller = null;
      busy = false;
      phase = 'idle';
    }
  }
  const invoke = (args, secrets = []) =>
    withPassphrases(capability.executable, args, secrets, { helper, signal: controller.signal });
  async function describe(line, dir, extra = {}) {
    const info = publicLine(line);
    await fs.writeFile(path.join(dir, 'public'), info.line + '\n', { mode: 0o600 });
    const out = await invoke(['-l', '-v', '-E', 'sha256', '-f', path.join(dir, 'public')]);
    const lines = out.stdout.trim().split(/\r?\n/);
    if (!lines[0]?.includes(info.fingerprint))
      throw Error('The public-key fingerprint could not be verified.');
    return {
      ...info,
      bits: Number(lines[0].split(' ')[0]),
      randomart: lines.slice(1).join('\n'),
      ...extra,
    };
  }
  async function createDirectory(name) {
    if (!destination) throw Error('Choose an output folder.');
    if ((await fs.realpath(destination)) !== destination)
      throw Error('Choose the output folder again.');
    const dir = path.join(destination, name);
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code === 'EEXIST') throw Error('That key folder already exists. Choose another name.');
      throw Error('The key folder could not be created.');
    }
    try {
      await permissions(dir, 'set', controller.signal);
      return dir;
    } catch (e) {
      await fs.rmdir(dir).catch(() => {});
      throw e;
    }
  }
  async function finishPair(dir, passphrase) {
    const privateFile = path.join(dir, 'key'),
      publicFile = privateFile + '.pub';
    const bytes = await fs.readFile(privateFile);
    let cipher;
    try {
      cipher = privateCipher(bytes.toString('utf8'));
      if (!cipher || Boolean(passphrase) !== (cipher !== 'none'))
        throw Error('Key encryption did not match the selected settings.');
    } finally {
      bytes.fill(0);
    }
    phase = 'Verifying key pair';
    const derived = publicLine(
      (await invoke(['-y', '-f', privateFile], passphrase ? [passphrase] : [])).stdout,
    );
    const published = publicLine(await fs.readFile(publicFile, 'utf8'));
    if (
      derived.line.split(' ').slice(0, 2).join(' ') !==
      published.line.split(' ').slice(0, 2).join(' ')
    )
      throw Error('The private and public keys do not match.');
    await permissions(dir, 'set', controller.signal);
    const value = await describe(published.line, dir, {
      privatePath: privateFile,
      publicPath: publicFile,
      directory: dir,
      encrypted: cipher !== 'none',
      cipher,
      permissions: 'Owner-only',
      origin: 'saved',
    });
    await fs.unlink(path.join(dir, 'public'));
    result = value;
    const bytes2 = await fs.readFile(privateFile);
    selection = { path: privateFile, kind: 'private', hash: digest(bytes2) };
    bytes2.fill(0);
    return status();
  }
  async function generate(options) {
    const spec = validate(options);
    return operation(async () => {
      let dir,
        complete = false;
      try {
        phase = 'Generating key pair';
        dir = await createDirectory(spec.name);
        const args = [
          '-q',
          '-t',
          spec.algorithm,
          '-o',
          '-a',
          String(spec.rounds),
          '-C',
          spec.comment,
          '-f',
          path.join(dir, 'key'),
        ];
        if (spec.algorithm !== 'ed25519') args.push('-b', String(spec.bits));
        await invoke(args, [spec.passphrase, spec.passphrase]);
        const state = await finishPair(dir, spec.passphrase);
        complete = true;
        return state;
      } finally {
        spec.passphrase = '';
        if (dir && !complete) await clean(dir);
      }
    });
  }
  async function inspect(passphrase = '') {
    phrase(passphrase);
    return operation(async () => {
      let dir;
      try {
        phase = 'Inspecting key';
        dir = await scratch();
        const bytes = await source();
        let line, cipher;
        try {
          await fs.writeFile(path.join(dir, 'key'), bytes, { mode: 0o600, flag: 'wx' });
          if (selection.kind === 'private') {
            cipher = privateCipher(bytes.toString('utf8'));
            line = (await invoke(['-y', '-f', path.join(dir, 'key')], [passphrase])).stdout;
          } else {
            const text = bytes.toString('utf8').trim();
            if (text.startsWith('---- BEGIN SSH2 PUBLIC KEY ----'))
              line = (await invoke(['-i', '-m', 'RFC4716', '-f', path.join(dir, 'key')])).stdout;
            else if (/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(text)) line = publicFromPEM(text);
            else line = text;
          }
        } finally {
          bytes.fill(0);
        }
        result = await describe(line, dir, {
          origin: 'inspected',
          sourcePath: selection.path,
          encrypted: cipher ? cipher !== 'none' : null,
          cipher,
        });
        return status();
      } finally {
        passphrase = '';
        await clean(dir);
      }
    });
  }
  async function change(options) {
    const spec = validate(options),
      old = phrase(options.oldPassphrase ?? '');
    if (selection?.kind !== 'private') throw Error('Choose a private key first.');
    return operation(async () => {
      let dir,
        complete = false;
      try {
        phase = 'Protecting key copy';
        dir = await createDirectory(spec.name);
        const bytes = await source();
        let encrypted;
        try {
          const text = bytes.toString('utf8'),
            cipher = privateCipher(text);
          encrypted = cipher ? cipher !== 'none' : /ENCRYPTED/.test(text);
          await fs.writeFile(path.join(dir, 'key'), bytes, { mode: 0o600, flag: 'wx' });
        } finally {
          bytes.fill(0);
        }
        const before = publicLine(
          (await invoke(['-y', '-f', path.join(dir, 'key')], [old])).stdout,
        );
        await invoke(
          ['-p', '-o', '-a', String(spec.rounds), '-f', path.join(dir, 'key')],
          encrypted ? [old, spec.passphrase, spec.passphrase] : [spec.passphrase, spec.passphrase],
        );
        const line = (
          await invoke(
            ['-y', '-f', path.join(dir, 'key')],
            spec.passphrase ? [spec.passphrase] : [],
          )
        ).stdout;
        if (publicLine(line).fingerprint !== before.fingerprint)
          throw Error('The key identity changed unexpectedly.');
        await fs.writeFile(path.join(dir, 'key.pub'), publicLine(line).line + '\n', {
          mode: 0o600,
          flag: 'wx',
        });
        const state = await finishPair(dir, spec.passphrase);
        complete = true;
        return state;
      } finally {
        spec.passphrase = '';
        if (dir && !complete) await clean(dir);
      }
    });
  }
  async function exportPublic(format = 'openssh') {
    if (!result) throw Error('Generate or inspect a key first.');
    if (!['openssh', 'RFC4716', 'PKCS8', 'PEM'].includes(format))
      throw Error('Choose a public-key format.');
    if (format === 'openssh') return result.line + '\n';
    return operation(async () => {
      let dir;
      try {
        phase = 'Exporting public key';
        dir = await scratch();
        await fs.writeFile(path.join(dir, 'public'), result.line + '\n', { mode: 0o600 });
        return (await invoke(['-e', '-m', format, '-f', path.join(dir, 'public')])).stdout;
      } finally {
        await clean(dir);
      }
    });
  }
  function clear() {
    if (busy) throw Error('Cancel the key operation first.');
    selection = null;
    result = null;
    return status();
  }
  return {
    status,
    refresh,
    selectFolder,
    selectFile,
    generate,
    inspect,
    change,
    exportPublic,
    clear,
    cancel: () => {
      controller?.abort();
      return status();
    },
    isBusy: () => busy,
    close: () => controller?.abort(),
  };
}
module.exports = {
  createSSHKeys,
  discover,
  validate,
  publicLine,
  privateCipher,
  withPassphrases,
  permissions,
};
