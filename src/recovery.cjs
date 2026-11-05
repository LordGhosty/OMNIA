const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');

async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file);
}
async function readJSON(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 65536) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Retains one verified installer for the currently running release before an update. */
function createRecovery({ directory, version, buildId, repository, verify, fetcher = fetch }) {
  const stateFile = path.join(directory, 'startup.json'),
    backupFile = path.join(directory, 'previous-setup.exe'),
    manifestFile = path.join(directory, 'backup.json');
  async function begin() {
    const previous = await readJSON(stateFile);
    const attempts =
      previous?.buildId === buildId && !previous.healthy ? (previous.attempts || 0) + 1 : 1;
    const state = {
      version,
      buildId,
      attempts,
      healthy: false,
      startedAt: new Date().toISOString(),
    };
    await writeJSON(stateFile, state);
    return state;
  }
  async function healthy() {
    const state = await readJSON(stateFile);
    if (state?.buildId === buildId)
      await writeJSON(stateFile, { ...state, healthy: true, attempts: 0 });
  }
  async function backup() {
    const info = await readJSON(manifestFile);
    if (!info) return null;
    try {
      if ((await digest(backupFile)) !== info.sha256) return null;
      await verify(backupFile);
      return { ...info, file: backupFile };
    } catch {
      return null;
    }
  }
  async function prepare() {
    const existing = await backup();
    if (existing?.version === version) return existing;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^\d+\.\d+\.\d+$/.test(version))
      throw Error('The release recovery source is not configured.');
    const tag = 'v' + version,
      name = `OMNIA-${version}-Setup.exe`;
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OMNIA' },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw Error('The current release installer is unavailable. The update was not installed.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1048576) throw Error('Invalid release metadata.');
      chunks.push(Buffer.from(chunk));
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    if (
      release.draft ||
      release.prerelease ||
      release.tag_name !== tag ||
      !release.assets?.some((asset) => asset.name === name && asset.browser_download_url === url)
    )
      throw Error('No matching stable recovery installer was found.');
    await fs.mkdir(directory, { recursive: true });
    const temp = path.join(directory, crypto.randomUUID() + '.partial');
    try {
      const download = await fetcher(url, { signal: AbortSignal.timeout(600000) });
      if (!download.ok || !download.body)
        throw Error('The recovery installer could not be downloaded.');
      let size = 0;
      const limit = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          done(
            size > 768 * 1024 ** 2 ? Error('Recovery installer exceeds the size limit.') : null,
            chunk,
          );
        },
      });
      await pipeline(
        Readable.fromWeb(download.body),
        limit,
        require('node:fs').createWriteStream(temp, { flags: 'wx' }),
      );
      await verify(temp);
      const info = { version, sha256: await digest(temp), savedAt: new Date().toISOString() };
      await fs.rename(temp, backupFile);
      await writeJSON(manifestFile, info);
      return { ...info, file: backupFile };
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  return { begin, healthy, backup, prepare, directory };
}
module.exports = { createRecovery, writeJSON, readJSON, digest };
