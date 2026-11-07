const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  hashFile,
  publicKeyFor,
  manifestName,
  optionalWindowsFiles,
} = require('../src/validation.cjs');
async function signRelease({ root, version, platform, arch, trust, privateKey }) {
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey),
    publicKey = publicKeyFor(trust);
  if (
    !['ed25519', 'rsa'].includes(key.asymmetricKeyType) ||
    !crypto
      .createPublicKey(key)
      .export({ type: 'spki', format: 'der' })
      .equals(publicKey.export({ type: 'spki', format: 'der' }))
  )
    throw Error('The release private key does not match the configured public key.');
  const files = [];
  async function walk(folder, prefix = '') {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name,
        file = path.join(folder, entry.name);
      if (relative === 'resources/' + manifestName) continue;
      if (entry.isSymbolicLink()) throw Error('Release files must not contain symbolic links.');
      if (entry.isDirectory()) await walk(file, relative + '/');
      else if (entry.isFile()) {
        const info = await fs.stat(file);
        const item = { path: relative, size: info.size, sha256: await hashFile(file) };
        if (platform === 'win32' && optionalWindowsFiles.has(relative)) item.optional = true;
        files.push(item);
      }
    }
  }
  await walk(root);
  if (!files.some((f) => f.path === 'resources/app.asar'))
    throw Error('No packaged application found.');
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      product: 'OMNIA',
      version,
      platform,
      arch,
      createdAt: new Date().toISOString(),
      files,
    }),
  );
  const envelope = {
    payload: payload.toString('base64'),
    signature: crypto
      .sign(key.asymmetricKeyType === 'rsa' ? 'sha256' : null, payload, key)
      .toString('base64'),
  };
  await fs.writeFile(path.join(root, 'resources', manifestName), JSON.stringify(envelope) + '\n');
  return files.length;
}
async function hook(context) {
  if (process.env.OMNIA_OFFICIAL_RELEASE !== '1') return;
  const trust = require('../assets/release-trust.json');
  const privateKey = require('./release-key.cjs').loadKey();
  const platform = context.electronPlatformName;
  if (platform === 'win32' && trust.mode !== 'release-key') {
    await require('../src/validation.cjs').checkWindowsSignature(
      path.join(context.appOutDir, 'OMNIA.exe'),
      trust,
    );
    for (const name of ['OMNIA Recovery.exe', 'OMNIA Validator.exe'])
      await require('../src/validation.cjs').checkWindowsSignature(
        path.join(context.appOutDir, name),
        trust,
      );
  }
  const arch =
    typeof context.arch === 'string' ? context.arch : require('builder-util').Arch[context.arch];
  await signRelease({
    root: context.appOutDir,
    version: context.packager.appInfo.version,
    platform,
    arch,
    trust,
    privateKey,
  });
}
module.exports = { signRelease, hook };
