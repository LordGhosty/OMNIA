const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { download } = require('./ffmpeg.cjs');
const inputs = require('./ffmpeg-windows-sources.json');

async function archive(outDir) {
  const cache = path.resolve(__dirname, '../vendor/ffmpeg-windows-sources');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  for (const [name, url, hash] of inputs) {
    const file = path.join(cache, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await download(url, file, hash);
  }
  await fs.copyFile(
    require.resolve('./ffmpeg-windows-sources.json'),
    path.join(cache, 'sources.json'),
  );
  const output = path.resolve(outDir, 'OMNIA-FFmpeg-Windows-sources.tar');
  const tmp = output + '.' + process.pid;
  try {
    execFileSync(
      'tar',
      ['-cf', tmp, '-C', cache, 'sources.json', ...inputs.map(([name]) => name)],
      { windowsHide: true },
    );
    await fs.rename(tmp, output);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return output;
}
module.exports = { archive };
