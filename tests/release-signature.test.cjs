const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { signArtifact } = require('../scripts/sign-artifact.cjs');
const { verifyArtifact, fetchEnvelope, newer } = require('../src/release-signature.cjs');
const { signRelease } = require('../scripts/sign-release.cjs');
const { verifyRelease } = require('../src/validation.cjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
const trust = {
  schema: 1,
  mode: 'release-key',
  repository: 'fixture/omnia',
  publicKey: publicKey.export({ format: 'pem', type: 'spki' }),
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-signature-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'setup.exe');
  await fs.writeFile(file, 'fixture executable');
  const envelope = await signArtifact(file, 'installer', {
    trust,
    key: privateKey,
    version: '0.0.4',
  });
  return { root, file, envelope };
}

test('artifact verification binds bytes, repository, role, version and expiry', async (t) => {
  const { file, envelope } = await fixture(t);
  assert.equal(
    (await verifyArtifact(file, envelope, trust, { version: '0.0.4', fresh: true })).version,
    '0.0.4',
  );
  await assert.rejects(verifyArtifact(file, envelope, trust, { version: '0.0.3' }));
  await assert.rejects(verifyArtifact(file, envelope, { ...trust, repository: 'other/repo' }));
  await assert.rejects(verifyArtifact(file, envelope, trust, { kind: 'validator' }));
  await assert.rejects(
    verifyArtifact(file, envelope, trust, { fresh: true, now: Date.now() + 92 * 86400000 }),
  );
  assert.equal(
    (await verifyArtifact(file, envelope, trust, { now: Date.now() + 92 * 86400000 })).version,
    '0.0.4',
  );
  const changed = { ...envelope, signature: Buffer.alloc(512).toString('base64') };
  await assert.rejects(verifyArtifact(file, changed, trust));
  await fs.appendFile(file, 'tampered');
  await assert.rejects(verifyArtifact(file, envelope, trust));
});

test('signed inventory verifies without claiming Windows publisher certification', async (t) => {
  const { root, file } = await fixture(t);
  await fs.mkdir(path.join(root, 'resources'));
  await fs.writeFile(path.join(root, 'resources/app.asar'), 'fixture archive');
  const options = {
    root,
    executable: file,
    trust,
    version: '0.0.4',
    platform: 'win32',
    arch: 'x64',
  };
  await signRelease({ ...options, privateKey });
  const result = await verifyRelease(options);
  assert.equal(result.state, 'validated');
  assert.equal(result.label, 'RELEASE SIGNATURE VERIFIED');
  const uninstaller = path.join(root, 'Uninstall OMNIA.exe');
  await fs.writeFile(uninstaller, 'fixture uninstaller');
  assert.equal((await verifyRelease(options)).state, 'unvalidated');
  await signArtifact(uninstaller, 'uninstaller', { trust, key: privateKey, version: '0.0.4' });
  assert.equal((await verifyRelease(options)).state, 'validated');
  await fs.appendFile(uninstaller, 'changed');
  assert.equal((await verifyRelease(options)).state, 'unvalidated');
});

test('signature downloads are bounded and older or malformed versions are rejected', async () => {
  await assert.rejects(
    fetchEnvelope('https://example.invalid', async () => new Response('a'.repeat(17000))),
  );
  for (const version of ['0.0.2', '0.0.3', '0.0.4-beta', '../1', '999999999999999999999.0.0'])
    assert.equal(newer(version, '0.0.3'), false);
  assert.equal(newer('0.0.4', '0.0.3'), true);
});

test('own-key updater verifies GitHub sidecars before becoming installable', async (t) => {
  const { file, envelope } = await fixture(t);
  const { EventEmitter } = require('node:events');
  const emitter = new EventEmitter();
  let installed = 0;
  emitter.quitAndInstall = () => installed++;
  const update = require('../src/updates.cjs').createUpdates({
    app: { isPackaged: true, getVersion: () => '0.0.3' },
    window: { isDestroyed: () => true },
    settings: { enabled: true, repository: trust.repository },
    platform: 'win32',
    trust,
    automaticCheck: false,
    updaterFactory: () => emitter,
    isBusy: () => false,
    recovery: { prepare: async () => {} },
    fetcher: async (url) => {
      assert.equal(
        url,
        'https://github.com/fixture/omnia/releases/download/v0.0.4/OMNIA-0.0.4-Setup.exe.sig',
      );
      return new Response(JSON.stringify(envelope));
    },
  });
  const receive = emitter.listeners('update-downloaded')[0];
  await receive({ version: '0.0.4', downloadedFile: file });
  assert.equal((await update('status')).state, 'downloaded');
  await fs.appendFile(file, 'changed after download');
  await update('install');
  await new Promise(setImmediate);
  assert.equal(installed, 0);
  assert.equal((await update('status')).state, 'error');
  await receive({ version: '0.0.2', downloadedFile: file });
  assert.equal((await update('status')).state, 'error');
});

test('a forged updater listing cannot claim a signed newer release is up to date', async (t) => {
  const { envelope } = await fixture(t);
  const emitter = new (require('node:events').EventEmitter)();
  emitter.checkForUpdates = async () => emitter.emit('update-not-available');
  const update = require('../src/updates.cjs').createUpdates({
    app: { isPackaged: true, getVersion: () => '0.0.3' },
    window: { isDestroyed: () => true },
    settings: { enabled: true, repository: trust.repository },
    trust,
    platform: 'win32',
    automaticCheck: false,
    updaterFactory: () => emitter,
    fetcher: async () => new Response(JSON.stringify(envelope)),
  });
  await update('check');
  await new Promise(setImmediate);
  assert.equal((await update('status')).state, 'error');
});

test('recovery retains and rechecks the installer signature', async (t) => {
  const { root, file, envelope } = await fixture(t);
  const bytes = await fs.readFile(file);
  const { readEnvelope } = require('../src/release-signature.cjs');
  const recovery = require('../src/recovery.cjs').createRecovery({
    directory: path.join(root, 'recovery'),
    version: '0.0.4',
    buildId: 'fixture',
    repository: trust.repository,
    trust,
    verify: async (target) => verifyArtifact(target, await readEnvelope(target + '.sig'), trust),
    fetcher: async (url) =>
      url.includes('api.github.com')
        ? new Response(
            JSON.stringify({
              tag_name: 'v0.0.4',
              assets: [
                {
                  name: 'OMNIA-0.0.4-Setup.exe',
                  browser_download_url:
                    'https://github.com/fixture/omnia/releases/download/v0.0.4/OMNIA-0.0.4-Setup.exe',
                },
              ],
            }),
          )
        : new Response(url.endsWith('.sig') ? JSON.stringify(envelope) : bytes),
  });
  assert.equal((await recovery.prepare()).version, '0.0.4');
  assert.ok(await recovery.backup());
  await fs.writeFile(path.join(root, 'recovery/previous-setup.exe.sig'), '{}');
  assert.equal(await recovery.backup(), null);
});

test(
  'standalone Windows verifier accepts the owner signature and rejects tampering',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, file } = await fixture(t);
    const { execFileSync, spawnSync } = require('node:child_process');
    const jwk = publicKey.export({ format: 'jwk' });
    const xml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, 'base64url').toString('base64')}</Modulus><Exponent>${Buffer.from(jwk.e, 'base64url').toString('base64')}</Exponent></RSAKeyValue>`;
    await fs.writeFile(
      path.join(root, 'publisher.cs'),
      (await fs.readFile(path.join(__dirname, '../src/publisher.cs'), 'utf8'))
        .replace('__CERTIFICATE_PINS__', '')
        .replace('__RELEASE_KEY_XML__', xml)
        .replace('__RELEASE_REPOSITORY__', trust.repository),
    );
    await fs.writeFile(
      path.join(root, 'check.cs'),
      'class Check { static int Main(string[] args) { return Publisher.Verify(args[0], "installer") ? 0 : 1; } }',
    );
    const exe = path.join(root, 'check.exe');
    execFileSync(
      path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/reference:System.Web.Extensions.dll',
        '/out:' + exe,
        path.join(root, 'publisher.cs'),
        path.join(root, 'check.cs'),
      ],
      { windowsHide: true },
    );
    assert.equal(spawnSync(exe, [file], { windowsHide: true }).status, 0);
    await fs.appendFile(file, 'tampered');
    assert.equal(spawnSync(exe, [file], { windowsHide: true }).status, 1);
  },
);
