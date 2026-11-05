const fs = require('node:fs/promises');
const path = require('node:path');
const { hashFile, checkWindowsSignature } = require('../src/validation.cjs');

module.exports = async ({ outDir, artifactPaths }) => {
  const setup = artifactPaths.find((file) => file.endsWith('-Setup.exe'));
  if (!setup) return [];
  const validator = path.join(outDir, 'OMNIA-Validator.exe');
  await fs.copyFile(path.join(outDir, 'win-unpacked', 'OMNIA Validator.exe'), validator);
  if (process.env.OMNIA_OFFICIAL_RELEASE === '1') {
    const trust = require('../assets/release-trust.json');
    for (const file of [setup, validator]) await checkWindowsSignature(file, trust);
  }
  const sums = path.join(outDir, 'SHA256SUMS.txt');
  const lines = [];
  for (const file of [setup, validator])
    lines.push((await hashFile(file)) + '  ' + path.basename(file));
  await fs.writeFile(sums, lines.join('\n') + '\n');
  return [validator, sums];
};
