const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');

const version = '8.1.3-2';
const root = path.resolve(__dirname, '..', 'vendor');
const cache = path.join(root, 'ffmpeg-cache');
const sourceName = `jellyfin-ffmpeg-${version}.tar.gz`;
const builds = {
  win32: {
    archive: 'win64-clang-gpl.zip',
    sha256: 'b65dd5011a80b5abec08bd559489cf188217238c8e38b5bf553504c974f5694d',
    files: {
      'ffmpeg.exe': '90a67fc4bf07bbf4a996d890bd94ba09f38550abacb3b425c3bb0b7ba9933421',
      'ffprobe.exe': '4af976137fae454a33c67f32b297621ed921f4ae418754e14bf6c53b5e99105c',
    },
  },
  linux: {
    archive: 'linux64-gpl.tar.xz',
    sha256: '1df84d04c4322902dba81c290508cdf3d89524d210b9fe03154bea6c4e3bfbb6',
    files: {
      ffmpeg: 'c03a86655431dd0bc2412f0c98c9712445b63c17daee3a9a6e4008c962a56ad1',
      ffprobe: '72733c695f2445f61f79a7b6b68a02a05523c032f28f63649cdfdb2df8cb0622',
    },
  },
};
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, file, expected) {
  if ((await digest(file).catch(() => '')) === expected) return;
  const tmp = file + '.' + process.pid;
  try {
    const response = await fetch(url);
    if (!response.ok) throw Error(`Download failed (${response.status}): ${url}`);
    await pipeline(response.body, createWriteStream(tmp, { flags: 'wx' }));
    if ((await digest(tmp)) !== expected) throw Error('Checksum mismatch: ' + url);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
async function verify(platform, folder) {
  for (const [file, hash] of Object.entries(builds[platform].files)) {
    if ((await digest(path.join(folder, file))) !== hash)
      throw Error('Unexpected media binary: ' + file);
  }
}
async function prepare() {
  const build = builds[process.platform];
  if (!build || process.arch !== 'x64')
    throw Error('The packaged media tools require Windows or Linux x64.');
  const directory = path.join(root, process.platform);
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  const name = `jellyfin-ffmpeg_${version}_portable_${build.archive}`;
  const archive = path.join(cache, name);
  const source = path.join(cache, sourceName);
  await download(
    `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${version}/${name}`,
    archive,
    build.sha256,
  );
  await download(
    `https://codeload.github.com/jellyfin/jellyfin-ffmpeg/tar.gz/refs/tags/v${version}`,
    source,
    'f8fefe98e57cb02b884bc67b843712071b7c652822b86786fd64da7e015e4078',
  );
  const stage = await fs.mkdtemp(path.join(cache, 'extract-'));
  try {
    execFileSync('tar', ['-xf', archive, '-C', stage, ...Object.keys(build.files)], {
      windowsHide: true,
    });
    await verify(process.platform, stage);
    for (const file of Object.keys(build.files))
      await fs.copyFile(path.join(stage, file), path.join(directory, file));
    const license = execFileSync(
      'tar',
      ['-xOf', source, `jellyfin-ffmpeg-${version}/COPYING.GPLv3`],
      { windowsHide: true },
    );
    await fs.writeFile(path.join(directory, 'FFMPEG-LICENSE.txt'), license);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
module.exports = { prepare, verify, download };
if (require.main === module)
  prepare().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
