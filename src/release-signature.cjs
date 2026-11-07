const crypto = require('node:crypto');
const fs = require('node:fs/promises');

function publicKey(trust) {
  const key = crypto.createPublicKey(trust.publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 4096)
    throw Error('A 4096-bit RSA release key is required.');
  return key;
}

function verifyEnvelope(envelope, trust) {
  if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string')
    throw Error('Missing release signature.');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (
    !crypto.verify('sha256', payload, publicKey(trust), Buffer.from(envelope.signature, 'base64'))
  )
    throw Error('The release signature is not trusted.');
  return JSON.parse(payload.toString('utf8'));
}

function verifyMetadata(
  envelope,
  trust,
  { version, kind = 'installer', fresh = false, now = Date.now() } = {},
) {
  const data = verifyEnvelope(envelope, trust);
  if (
    data.schema !== 1 ||
    data.product !== 'OMNIA' ||
    data.purpose !== 'release-artifact' ||
    data.repository !== trust.repository ||
    data.platform !== 'win32' ||
    data.arch !== 'x64' ||
    data.kind !== kind ||
    !/^\d+\.\d+\.\d+$/.test(data.version) ||
    (version && data.version !== version) ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.size > 768 * 1024 ** 2
  )
    throw Error('The signed artifact identity does not match this release.');
  const created = Date.parse(data.createdAt),
    expires = Date.parse(data.expiresAt);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    expires <= created ||
    expires - created > 91 * 86400000 ||
    (fresh && (created > now + 300000 || expires <= now))
  )
    throw Error('The release signature has expired or has an invalid date.');
  return data;
}

/** Verifies an artifact against the pinned key and an expected release identity. */
async function verifyArtifact(file, envelope, trust, options = {}) {
  const data = verifyMetadata(envelope, trust, options);
  const stat = await fs.stat(file);
  if (stat.size !== data.size || (await require('./validation.cjs').hashFile(file)) !== data.sha256)
    throw Error('The downloaded file does not match its release signature.');
  return data;
}

async function readEnvelope(file) {
  if ((await fs.stat(file)).size > 16384) throw Error('Release signature exceeds the size limit.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function fetchEnvelope(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw Error('The release signature is unavailable.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16384) throw Error('Release signature exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function newer(a, b) {
  if (
    ![a, b].every(
      (v) => /^\d+\.\d+\.\d+$/.test(v) && v.split('.').every((n) => Number.isSafeInteger(+n)),
    )
  )
    return false;
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

module.exports = {
  publicKey,
  verifyEnvelope,
  verifyMetadata,
  verifyArtifact,
  readEnvelope,
  fetchEnvelope,
  newer,
};
