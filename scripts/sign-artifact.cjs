const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { hashFile } = require('../src/validation.cjs');

async function signArtifact(
  file,
  kind,
  {
    trust = require('../assets/release-trust.json'),
    version = require('../package.json').version,
    key = require('./release-key.cjs').loadKey(),
  } = {},
) {
  const pub = require('../src/release-signature.cjs').publicKey(trust);
  if (
    !crypto
      .createPublicKey(key)
      .export({ type: 'spki', format: 'der' })
      .equals(pub.export({ type: 'spki', format: 'der' }))
  )
    throw Error('The release key does not match the pinned identity.');
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      product: 'OMNIA',
      purpose: 'release-artifact',
      repository: trust.repository,
      version,
      platform: 'win32',
      arch: 'x64',
      kind,
      size: (await fs.stat(file)).size,
      sha256: await hashFile(file),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 90 * 86400000).toISOString(),
    }),
  );
  const envelope = {
    payload: payload.toString('base64'),
    signature: crypto.sign('sha256', payload, key).toString('base64'),
  };
  await fs.writeFile(file + '.sig', JSON.stringify(envelope) + '\n');
  return envelope;
}

async function hook(configuration) {
  if (process.env.OMNIA_OFFICIAL_RELEASE !== '1') return;
  if (configuration.path.endsWith('__uninstaller.exe'))
    await signArtifact(configuration.path, 'uninstaller');
  if (require('node:path').basename(configuration.path) === 'elevate.exe')
    await signArtifact(configuration.path, 'update-helper');
}
module.exports = hook;
module.exports.signArtifact = signArtifact;
