const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function keyPath() {
  if (process.platform !== 'win32') throw Error('Local key storage requires Windows.');
  return path.join(process.env.LOCALAPPDATA, 'OMNIA Signing', 'release-key.dpapi');
}

function protect(input, decrypt = false) {
  const script =
    "Add-Type -AssemblyName System.Security;$ErrorActionPreference='Stop';" +
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());' +
    '$r=[Security.Cryptography.ProtectedData]::' +
    (decrypt ? 'Unprotect' : 'Protect') +
    '($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($r))';
  const result = spawnSync(
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { input: input.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  if (result.status !== 0) throw Error('Windows could not access the protected release key.');
  return Buffer.from(result.stdout, 'base64');
}

function loadKey() {
  if (process.env.OMNIA_RELEASE_PRIVATE_KEY)
    return crypto.createPrivateKey({
      key: Buffer.from(process.env.OMNIA_RELEASE_PRIVATE_KEY, 'base64'),
      passphrase: process.env.OMNIA_RELEASE_KEY_PASSWORD,
    });
  const pem = protect(fs.readFileSync(keyPath()), true);
  try {
    return crypto.createPrivateKey(pem);
  } finally {
    pem.fill(0);
  }
}

function provision() {
  const file = keyPath();
  if (fs.existsSync(file)) throw Error('A release key already exists. It will not be replaced.');
  const trustPath = path.join(__dirname, '../assets/release-trust.json');
  const trust = JSON.parse(fs.readFileSync(trustPath));
  if (trust.publicKey) throw Error('A public identity is already configured.');
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
  const pem = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, protect(pem), { flag: 'wx' });
  } finally {
    pem.fill(0);
  }
  trust.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  trust.mode = 'release-key';
  trust.repository = 'LordGhosty/OMNIA';
  fs.writeFileSync(trustPath, JSON.stringify(trust, null, 2) + '\n');
  console.log('Created a Windows-user-protected release key outside the checkout.');
  console.log(
    'Public key fingerprint: ' +
      crypto
        .createHash('sha256')
        .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
  );
}

async function password(prompt) {
  if (!process.stdin.isTTY) throw Error('Use an interactive terminal for key backups.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const input = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n' || char === '\u0003') {
          process.stdin.off('data', input);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          if (char === '\u0003') reject(Error('Cancelled.'));
          else resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', input);
  });
}

async function main() {
  const [action, target] = process.argv.slice(2);
  if (action === 'init') return provision();
  if (!['backup', 'restore'].includes(action) || !target)
    throw Error('Usage: release-key.cjs init | backup <encrypted.pem> | restore <encrypted.pem>');
  const file = path.resolve(target),
    root = path.resolve(__dirname, '..');
  const relative = path.relative(root, file);
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    throw Error('Keep key backups outside the project.');
  const phrase = await password(
    action === 'backup' ? 'New backup passphrase (hidden): ' : 'Backup passphrase (hidden): ',
  );
  if (action === 'backup') {
    if (phrase.length < 16) throw Error('Use a passphrase of at least 16 characters.');
    if (phrase !== (await password('Repeat passphrase (hidden): ')))
      throw Error('Passphrases differ.');
    const pem = loadKey().export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: phrase,
    });
    fs.writeFileSync(file, pem, { flag: 'wx' });
    console.log('Encrypted backup saved. Keep it and its passphrase separately.');
  } else {
    if (fs.existsSync(keyPath())) throw Error('A local release key already exists.');
    if (fs.statSync(file).size > 16384) throw Error('Invalid key backup.');
    const key = crypto.createPrivateKey({ key: fs.readFileSync(file), passphrase: phrase });
    const expected = crypto.createPublicKey(require('../assets/release-trust.json').publicKey);
    if (
      !crypto
        .createPublicKey(key)
        .export({ type: 'spki', format: 'der' })
        .equals(expected.export({ type: 'spki', format: 'der' }))
    )
      throw Error('The backup does not match the public release identity.');
    const pem = Buffer.from(key.export({ type: 'pkcs8', format: 'pem' }));
    fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
    try {
      fs.writeFileSync(keyPath(), protect(pem), { flag: 'wx' });
    } finally {
      pem.fill(0);
    }
    console.log('Restored the matching key into Windows-protected storage.');
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { loadKey, keyPath };
