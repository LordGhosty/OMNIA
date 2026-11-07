const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyRelease, createValidation, checkWindowsSignature } = require('../src/validation.cjs');
const { signRelease } = require('../scripts/sign-release.cjs');
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-validation-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const trust = {
    schema: 1,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    windowsPublisherName: 'TEST ONLY',
    windowsCertificateSha256: ['a'.repeat(64)],
  };
  const options = {
    root,
    executable: path.join(root, 'OMNIA.exe'),
    version: '0.0.2',
    platform: 'win32',
    arch: 'x64',
    trust,
    windowsCheck: async () => 'TEST ONLY',
  };
  await fs.mkdir(path.join(root, 'resources', 'bin'), { recursive: true });
  await fs.writeFile(options.executable, 'test executable');
  await fs.writeFile(path.join(root, 'resources', 'app.asar'), 'test archive');
  await fs.writeFile(path.join(root, 'resources', 'bin', 'helper.exe'), 'test helper');
  const sign = () =>
    signRelease({ ...options, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  try {
    await sign();
    await fn({ root, trust, options, sign, privateKey });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('official-file verification succeeds with a matching test key and publisher check', () =>
  fixture(async ({ options }) => {
    const result = await verifyRelease(options);
    assert.equal(result.state, 'validated');
    assert.equal(result.files, 3);
    assert.equal(result.publisher, 'TEST ONLY');
    assert.equal(result.keyFingerprint.length, 64);
  }));
test('unsigned, development and missing-trust builds fail closed', () =>
  fixture(async ({ options, root }) => {
    assert.equal((await verifyRelease({ ...options, trust: { schema: 1 } })).state, 'unvalidated');
    assert.equal((await verifyRelease({ ...options, packaged: false })).state, 'unvalidated');
    await fs.unlink(path.join(root, 'resources', 'omnia-release.json'));
    assert.equal((await verifyRelease(options)).state, 'unvalidated');
    const service = createValidation({ ...options, trust: { schema: 1 } });
    service.start();
    assert.equal(service.status().state, 'unvalidated');
    service.close();
  }));
test('changes to app code or a native helper invalidate the signed release', () =>
  fixture(async ({ root, options, sign }) => {
    for (const file of ['resources/app.asar', 'resources/bin/helper.exe', 'OMNIA.exe']) {
      await sign();
      await fs.appendFile(path.join(root, file), 'tampered');
      const r = await verifyRelease(options);
      assert.equal(r.state, 'unvalidated');
      assert.match(r.reason, /changed/);
    }
  }));
test('replacement keys, signatures, versions and platforms are rejected', () =>
  fixture(async ({ root, options, trust }) => {
    const other = crypto.generateKeyPairSync('ed25519');
    for (const change of [
      { trust: { ...trust, publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) } },
      { version: '0.0.3' },
      { platform: 'linux' },
      { arch: 'arm64' },
    ])
      assert.equal((await verifyRelease({ ...options, ...change })).state, 'unvalidated');
    const file = path.join(root, 'resources', 'omnia-release.json'),
      envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    envelope.signature = Buffer.alloc(64).toString('base64');
    await fs.writeFile(file, JSON.stringify(envelope));
    assert.equal((await verifyRelease(options)).state, 'unvalidated');
  }));
test('a valid release manifest cannot bypass a failed Windows publisher check', () =>
  fixture(async ({ options }) => {
    const result = await verifyRelease({
      ...options,
      windowsCheck: async () => {
        throw Error('Publisher mismatch');
      },
    });
    assert.equal(result.state, 'unvalidated');
    assert.equal(result.reason, 'Publisher mismatch');
  }));
test('signed traversal, duplicate and incomplete inventories fail validation', () =>
  fixture(async ({ root, options, privateKey }) => {
    const file = path.join(root, 'resources', 'omnia-release.json'),
      original = JSON.parse(
        Buffer.from(JSON.parse(await fs.readFile(file, 'utf8')).payload, 'base64'),
      );
    const variants = [
      { ...original, files: [{ ...original.files[0], path: '../outside' }] },
      { ...original, files: [...original.files, original.files[0]] },
      { ...original, files: original.files.filter((f) => f.path !== 'resources/app.asar') },
    ];
    for (const variant of variants) {
      const payload = Buffer.from(JSON.stringify(variant));
      await fs.writeFile(
        file,
        JSON.stringify({
          payload: payload.toString('base64'),
          signature: crypto.sign(null, payload, privateKey).toString('base64'),
        }),
      );
      assert.equal((await verifyRelease(options)).state, 'unvalidated');
    }
  }));
test('manifest signing refuses an unrelated private key', () =>
  fixture(async ({ options }) => {
    const other = crypto.generateKeyPairSync('ed25519');
    await assert.rejects(
      signRelease({
        ...options,
        privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
      /does not match/,
    );
  }));
test('optional utilities may be omitted but installed utilities must match their signed hashes', () =>
  fixture(async ({ root, options, sign }) => {
    for (const name of ['OMNIA Recovery.exe', 'OMNIA Validator.exe'])
      await fs.writeFile(path.join(root, name), 'test utility');
    await sign();
    assert.equal((await verifyRelease(options)).state, 'validated');
    await fs.unlink(path.join(root, 'OMNIA Recovery.exe'));
    await fs.unlink(path.join(root, 'OMNIA Validator.exe'));
    assert.equal((await verifyRelease(options)).state, 'validated');
    await fs.writeFile(path.join(root, 'OMNIA Validator.exe'), 'changed utility');
    assert.equal((await verifyRelease(options)).state, 'unvalidated');
    await fs.unlink(path.join(root, 'OMNIA Validator.exe'));
    await fs.unlink(path.join(root, 'resources', 'bin', 'helper.exe'));
    assert.equal((await verifyRelease(options)).state, 'unvalidated');
  }));

test('even a signed optional flag cannot exempt a required application file', () =>
  fixture(async ({ root, options, privateKey }) => {
    const file = path.join(root, 'resources', 'omnia-release.json');
    const manifest = JSON.parse(Buffer.from(JSON.parse(await fs.readFile(file)).payload, 'base64'));
    manifest.files.find((item) => item.path === 'resources/app.asar').optional = true;
    const payload = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(
      file,
      JSON.stringify({
        payload: payload.toString('base64'),
        signature: crypto.sign(null, payload, privateKey).toString('base64'),
      }),
    );
    assert.equal((await verifyRelease(options)).state, 'unvalidated');
  }));
test('Windows certificate verification rejects an unconfigured identity', async () => {
  await assert.rejects(checkWindowsSignature(process.execPath, {}), /not been configured/);
});
test('background verification reports a result without a renderer-supplied verdict', () =>
  fixture(async ({ options, privateKey }) => {
    const workerOptions = { ...options, platform: 'linux', packaged: true };
    delete workerOptions.windowsCheck;
    await signRelease({
      ...workerOptions,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    let service;
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Verification worker timed out')), 5000);
        service = createValidation(workerOptions, (state) => {
          if (state.state !== 'checking') {
            clearTimeout(timer);
            resolve(state);
          }
        });
        service.start();
      });
      assert.equal(result.state, 'validated');
    } finally {
      service?.close();
    }
  }));

test('Windows rejects extra program files and verifies the installer-created uninstaller', () =>
  fixture(async ({ root, options }) => {
    const extra = path.join(root, 'resources', 'injected.dll');
    await fs.writeFile(extra, 'extra file');
    assert.match((await verifyRelease(options)).reason, /unlisted/i);
    await fs.unlink(extra);
    const uninstaller = path.join(root, 'Uninstall OMNIA.exe');
    await fs.writeFile(uninstaller, 'fixture');
    const windowsCheck = async (file) => {
      if (file === uninstaller) throw Error('Unexpected uninstaller publisher');
      return 'TEST ONLY';
    };
    assert.match(
      (await verifyRelease({ ...options, windowsCheck })).reason,
      /uninstaller publisher/,
    );
    assert.equal((await verifyRelease(options)).state, 'validated');
  }));
