require('./source-check.cjs');
const fs = require('node:fs');
const path = require('node:path');

async function verify() {
  const asar = await import('@electron/asar');
  const root = path.resolve('release/win-unpacked');
  const archive = path.join(root, 'resources/app.asar');
  const files = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file.replaceAll('\\', '/'));
    }
  }
  for (const folder of ['src', 'web', 'assets']) walk(folder);
  files.push('LICENSE', 'THIRD_PARTY.md', 'TRADEMARKS.md', 'SECURITY.md');
  for (const file of files)
    if (!asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(file)))
      throw Error('Packaged source differs: ' + file);
  const packed = JSON.parse(asar.extractFile(archive, 'package.json'));
  const source = require('../package.json');
  for (const key of ['name', 'version', 'main'])
    if (packed[key] !== source[key]) throw Error('Packaged metadata differs: ' + key);
  const allowed = new Set([...files, 'package.json']);
  for (const entry of asar.listPackage(archive)) {
    const name = entry.replaceAll('\\', '/').replace(/^\//, '');
    if (name === 'node_modules' || name.startsWith('node_modules/')) continue;
    if (!allowed.has(name) && !files.some((file) => file.startsWith(name + '/')))
      throw Error('Unexpected packaged file: ' + name);
  }
  for (const [file, destination] of [
    ['omnia-askpass.exe', 'resources/bin/omnia-askpass.exe'],
    ['omnia-process-guard.exe', 'resources/bin/omnia-process-guard.exe'],
    ['OMNIA Recovery.exe', 'OMNIA Recovery.exe'],
    ['OMNIA Validator.exe', 'OMNIA Validator.exe'],
  ])
    if (
      !fs
        .readFileSync(path.join('vendor/win32', file))
        .equals(fs.readFileSync(path.join(root, destination)))
    ) {
      await require('../src/validation.cjs').checkWindowsSignature(
        path.join(root, destination),
        require('../assets/release-trust.json'),
      );
    }
  if (
    process.env.OMNIA_CHECK_SIGNED === '1' ||
    fs.existsSync(path.join(root, 'resources/omnia-release.json'))
  ) {
    const result = await require('../src/validation.cjs').verifyRelease({
      root,
      executable: path.join(root, 'OMNIA.exe'),
      version: packed.version,
      trust: require('../assets/release-trust.json'),
    });
    if (result.state !== 'validated') throw Error(result.reason);
  }
  console.log(
    'Packaged source matches ' + files.length + ' files; version ' + packed.version + '.',
  );
}
verify().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
