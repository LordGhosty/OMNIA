// Pinned runtime downloads.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const windows = process.platform === 'win32';
const platform = windows ? 'win32' : 'linux';
const directory = path.join(__dirname, '..', 'vendor', platform);
async function fetchAsset(url, hash, output) {
  try {
    if (
      crypto
        .createHash('sha256')
        .update(await fs.readFile(output))
        .digest('hex') === hash
    )
      return;
  } catch {}
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new Error(`Checksum mismatch: ${url}`);
  await fs.writeFile(output, bytes);
}
async function prepare() {
  await fs.mkdir(directory, { recursive: true });
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/';
  const name = windows ? 'yt-dlp.exe' : 'yt-dlp_linux';
  const sumsResponse = await fetch(base + 'SHA2-256SUMS');
  if (!sumsResponse.ok) throw new Error('Could not read yt-dlp checksums.');
  const sums = await sumsResponse.text();
  const hash = sums
    .split('\n')
    .find((line) => line.trim().endsWith(' ' + name))
    ?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('Missing yt-dlp checksum.');
  const ytdlpPath = path.join(directory, windows ? 'yt-dlp.exe' : 'yt-dlp');
  await fetchAsset(base + name, hash, ytdlpPath);
  const denoName = `deno-x86_64-${windows ? 'pc-windows-msvc' : 'unknown-linux-gnu'}.zip`;
  const denoHash = windows
    ? 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf'
    : 'e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609';
  const zip = path.join(directory, 'deno.zip');
  await fetchAsset(
    `https://github.com/denoland/deno/releases/download/v2.9.8/${denoName}`,
    denoHash,
    zip,
  );
  if (windows) {
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(directory)} -Force`,
      ],
      { windowsHide: true },
    );
  } else execFileSync('unzip', ['-o', zip, '-d', directory]);
  await fs.rm(zip);
  if (!windows) {
    await fs.chmod(ytdlpPath, 0o755);
    await fs.chmod(path.join(directory, 'deno'), 0o755);
  }
  await fs.writeFile(
    path.join(directory, 'VERSIONS.json'),
    JSON.stringify(
      { ytdlp: '2026.10.21', ytdlpSHA256: hash, deno: '2.9.8', denoArchiveSHA256: denoHash },
      null,
      2,
    ),
  );
  for (const [repo, tag, file, output] of [
    ['yt-dlp/yt-dlp', '2026.10.21', 'LICENSE', 'YT-DLP-LICENSE.txt'],
    ['denoland/deno', 'v2.9.8', 'LICENSE.md', 'DENO-LICENSE.txt'],
  ]) {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/${file}`);
    if (!response.ok) throw new Error(`Could not obtain ${output}`);
    await fs.writeFile(path.join(directory, output), await response.text());
  }
  console.log('Prepared verified yt-dlp 2026.10.21 and Deno 2.9.8:', directory);
}
prepare().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
