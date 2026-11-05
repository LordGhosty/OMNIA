const fs = require('node:fs');
const repository = process.env.GITHUB_REPOSITORY;
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const beta = process.env.OMNIA_BETA === 'true';
const version = beta ? p.version : process.env.RELEASE_VERSION;
if (beta && process.env.RELEASE_VERSION && process.env.RELEASE_VERSION !== version)
  throw Error('A beta uses the current source version.');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''))
  throw new Error('A valid GitHub repository is required.');
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '') ||
  version.split('.').some((n) => !Number.isSafeInteger(Number(n)))
)
  throw new Error('Choose a stable release version, for example 0.0.3.');
const trust = require('../assets/release-trust.json');
require('../src/validation.cjs').publicKeyFor(trust);
if (
  !trust.windowsPublisherName ||
  !Array.isArray(trust.windowsCertificateSha256) ||
  !trust.windowsCertificateSha256.length ||
  trust.windowsCertificateSha256.some((v) => !/^([a-fA-F0-9]{64})$/.test(v))
)
  throw Error(
    'Configure the official Windows publisher and certificate SHA-256 pins before publishing.',
  );
const compare = (a, b) => {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
if (!beta && compare(version, p.version) <= 0)
  throw new Error('The release version must be higher than the current source version.');
p.build.forceCodeSigning = true;
p.build.win.signExecutable = true;
p.build.win.verifyUpdateCodeSignature = true;
p.build.win.signtoolOptions = {
  ...p.build.win.signtoolOptions,
  publisherName: trust.windowsPublisherName,
  signingHashAlgorithms: ['sha256'],
};
const [owner, repo] = repository.split('/');
p.version = version;
if (!beta) p.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }];
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
lock.version = version;
lock.packages[''].version = version;
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
let launcher = fs.readFileSync('web/launcher.html', 'utf8');
launcher = launcher.replace(/V\.\d+\.\d+\.\d+/, 'V.' + version);
fs.writeFileSync('web/launcher.html', launcher);
fs.writeFileSync(
  'assets/updates.json',
  JSON.stringify({ enabled: !beta, repository: beta ? '' : repository }, null, 2) + '\n',
);
console.log(`Prepared ${repository} release ${version}. No credentials are included in the app.`);
