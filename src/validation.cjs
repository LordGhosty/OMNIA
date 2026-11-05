const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const manifestName = 'omnia-release.json';
const invalid = (reason) => ({ state: 'unvalidated', label: 'UNVALIDATED SOFTWARE', reason });
function publicKeyFor(trust) {
  if (trust?.schema !== 1 || !trust.publicKey)
    throw Error('Official release signing has not been configured.');
  const key = crypto.createPublicKey(trust.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Unsupported release signing key.');
  return key;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 }))
    hash.update(chunk);
  return hash.digest('hex');
}
async function checkWindowsSignature(executable, trust) {
  if (
    !trust.windowsPublisherName ||
    !Array.isArray(trust.windowsCertificateSha256) ||
    !trust.windowsCertificateSha256.length
  )
    throw Error('The Windows publisher identity has not been configured.');
  const ps = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  // Fixed publisher-verification command.
  const script =
    "$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';$s=Get-AuthenticodeSignature -LiteralPath $env:OMNIA_VERIFY_EXE;$fingerprint='';if($s.SignerCertificate){$h=[Security.Cryptography.SHA256]::Create();try{$fingerprint=([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}};@{status=[string]$s.Status;fingerprint=$fingerprint;subject=[string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress";
  const raw = await new Promise((resolve, reject) =>
    execFile(
      ps,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 32768,
        env: { ...process.env, OMNIA_VERIFY_EXE: executable },
      },
      (error, stdout) =>
        error
          ? reject(Error('Windows could not verify the publisher signature.'))
          : resolve(stdout),
    ),
  );
  const result = JSON.parse(raw);
  if (
    result.status !== 'Valid' ||
    !trust.windowsCertificateSha256.map((v) => String(v).toLowerCase()).includes(result.fingerprint)
  )
    throw Error('Windows did not confirm the expected publisher signature.');
  return result.subject;
}
/** Windows setup adds the uninstaller after the application inventory is signed. */
async function checkWindowsFiles(root, files, trust, verify) {
  const folders = [root];
  let entries = 0;
  while (folders.length) {
    const folder = folders.pop();
    const directory = await fsp.opendir(folder);
    for await (const item of directory) {
      if (++entries > 25000) throw Error('Unexpected number of release files.');
      const file = path.join(folder, item.name);
      const name = path.relative(root, file).split(path.sep).join('/').toLowerCase();
      if (item.isSymbolicLink()) throw Error('A release path was redirected.');
      if (item.isDirectory()) {
        folders.push(file);
      } else if (
        !files.has(name) &&
        /\.(?:exe|dll|node|asar|js|cjs|mjs|ps1|cmd|bat|vbs|com|scr)$/i.test(name)
      ) {
        if (name !== 'uninstall omnia.exe') throw Error('Unlisted program file: ' + name);
        await verify(file, trust);
      }
    }
  }
}
async function verifyRelease({
  root,
  executable,
  version,
  platform = process.platform,
  arch = process.arch,
  trust,
  packaged = true,
  windowsCheck = checkWindowsSignature,
}) {
  try {
    if (!packaged) return invalid('This is a development checkout, not a signed release.');
    const key = publicKeyFor(trust);
    const manifestFile = path.join(root, 'resources', manifestName),
      stat = await fsp.stat(manifestFile);
    if (stat.size > 2 * 1024 * 1024) throw Error('The release manifest is too large.');
    const envelope = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string')
      throw Error('The release signature is missing.');
    const payload = Buffer.from(envelope.payload, 'base64'),
      signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64 || !crypto.verify(null, payload, key, signature))
      throw Error('The release signature does not match the trusted OMNIA key.');
    const manifest = JSON.parse(payload.toString('utf8'));
    if (
      manifest.schema !== 1 ||
      manifest.product !== 'OMNIA' ||
      manifest.version !== version ||
      manifest.platform !== platform ||
      manifest.arch !== arch
    )
      throw Error('The signed release identity does not match this app.');
    if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000)
      throw Error('Invalid release file list.');
    const seen = new Set(),
      resolvedRoot = await fsp.realpath(root);
    for (const item of manifest.files) {
      const name = item.path;
      if (
        typeof name !== 'string' ||
        !name ||
        name.includes('\\') ||
        name.includes(':') ||
        name.startsWith('/') ||
        name.split('/').some((p) => !p || p === '.' || p === '..') ||
        seen.has(name.toLowerCase()) ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        throw Error('Invalid release file entry.');
      seen.add(name.toLowerCase());
      const file = path.join(resolvedRoot, ...name.split('/')),
        real = await fsp.realpath(file);
      if (real !== file) throw Error('A release file was redirected.');
      const info = await fsp.stat(file);
      if (!info.isFile() || info.size !== item.size || (await hashFile(file)) !== item.sha256)
        throw Error('A signed release file is missing or changed: ' + name);
    }
    const executablePath = path
      .relative(resolvedRoot, await fsp.realpath(executable))
      .split(path.sep)
      .join('/')
      .toLowerCase();
    if (!seen.has('resources/app.asar') || !seen.has(executablePath))
      throw Error('The signature does not cover the app and its executable.');
    if (platform === 'win32') await checkWindowsFiles(resolvedRoot, seen, trust, windowsCheck);
    const publisher =
      platform === 'win32' ? await windowsCheck(executable, trust) : 'OMNIA release key';
    return {
      state: 'validated',
      label: 'VALIDATED SOFTWARE',
      reason:
        'The signed release files match the trusted OMNIA release key.' +
        (platform === 'win32' ? ' Windows also confirmed the pinned publisher certificate.' : ''),
      publisher,
      version,
      checkedAt: new Date().toISOString(),
      files: manifest.files.length,
      keyFingerprint: crypto
        .createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    };
  } catch (error) {
    return invalid(
      error.code === 'ENOENT'
        ? 'A signed release manifest or required release file is missing.'
        : error.message || 'Release verification failed.',
    );
  }
}
function createValidation(options, onChange = () => {}) {
  let state = invalid('Release verification has not finished.'),
    worker,
    started = false;
  const send = (next) => {
    state = next;
    onChange(state);
  };
  return {
    status: () => state,
    start() {
      if (started) return;
      started = true;
      if (!options.packaged) {
        send(invalid('This is a development checkout, not a signed release.'));
        return;
      }
      try {
        publicKeyFor(options.trust);
      } catch (error) {
        send(invalid(error.message));
        return;
      }
      send({
        state: 'checking',
        label: 'CHECKING SOFTWARE',
        reason: 'Verifying the signed release files in the background.',
      });
      try {
        worker = new Worker(__filename, { workerData: options });
        worker.once('message', send);
        worker.once('error', () => send(invalid('The verification worker could not complete.')));
        worker.once('exit', () => {
          if (state.state === 'checking') send(invalid('Release verification did not finish.'));
        });
      } catch {
        send(invalid('Release verification could not start.'));
      }
    },
    close() {
      void worker?.terminate();
    },
  };
}
if (!isMainThread && workerData)
  void verifyRelease(workerData).then((result) => parentPort.postMessage(result));
module.exports = {
  verifyRelease,
  createValidation,
  hashFile,
  publicKeyFor,
  checkWindowsSignature,
  manifestName,
};
