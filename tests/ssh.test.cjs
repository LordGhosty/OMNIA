const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSSHKeys, validate, publicLine } = require('../src/ssh-keys.cjs');

test('SSH settings reject unsafe names, unsupported algorithms and implicit empty passphrases', () => {
  const base = { name: 'fixture', passphrase: 'test', confirm: 'test' };
  assert.equal(validate(base).algorithm, 'ed25519');
  for (const changes of [
    { name: '../key' },
    { name: 'CON' },
    { algorithm: 'dsa' },
    { bits: 42 },
    { rounds: 0 },
    { confirm: 'different' },
    { comment: 'two\nlines' },
    { passphrase: '', confirm: '' },
  ])
    assert.throws(() => validate({ ...base, ...changes }));
  assert.equal(validate({ ...base, passphrase: '', confirm: '', allowEmpty: true }).passphrase, '');
  assert.throws(() => publicLine('not a key'));
});

test(
  'native SSH key lifecycle preserves identity, protects files and refuses overwrite',
  { timeout: 180000 },
  async (t) => {
    const service = createSSHKeys();
    const initial = await service.refresh();
    if (!initial.capability.available) return t.skip(initial.capability.message);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-ssh-test-'));
    t.after(async () => {
      service.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    await service.selectFolder(root);
    const options = {
      name: 'ed25519',
      algorithm: 'ed25519',
      rounds: 16,
      comment: 'fixture',
      passphrase: 'test-κλειδί-123',
      confirm: 'test-κλειδί-123',
    };
    t.diagnostic('Generate encrypted Ed25519');
    const created = (await service.generate(options)).result;
    const selected = service.status().selection;
    for (const [name, content] of [
      ['image.png', Buffer.from('89504e470d0a1a0a', 'hex')],
      ['empty.key', ''],
      ['fake.pub', 'not a key'],
    ]) {
      const file = path.join(root, name);
      await fs.writeFile(file, content);
      await assert.rejects(service.selectFile(file), /Wrong file format/);
      assert.deepEqual(service.status().selection, selected);
    }
    assert.equal(created.type, 'ssh-ed25519');
    assert.equal(created.encrypted, true);
    assert.equal(created.permissions, 'Owner-only');
    assert.ok(!JSON.stringify(service.status()).includes(options.passphrase));
    const original = await fs.readFile(created.privatePath);
    assert.ok(original.toString().startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'));
    await assert.rejects(service.generate(options), /already exists/);
    t.diagnostic('Inspect and change passphrase');
    await assert.rejects(service.inspect('wrong-passphrase'), /OpenSSH/);
    assert.equal(service.isBusy(), false);
    assert.equal(
      (await service.inspect(options.passphrase)).result.fingerprint,
      created.fingerprint,
    );
    const changed = (
      await service.change({
        ...options,
        name: 'changed',
        oldPassphrase: options.passphrase,
        passphrase: 'replacement',
        confirm: 'replacement',
      })
    ).result;
    assert.equal(changed.fingerprint, created.fingerprint);
    assert.deepEqual(await fs.readFile(created.privatePath), original);
    await service.selectFile(changed.publicPath);
    assert.equal((await service.inspect()).result.fingerprint, created.fingerprint);
    assert.equal((await service.exportPublic('openssh')).trim(), service.status().result.line);
    service.clear();
    assert.equal(service.status().result, null);
    assert.deepEqual(await fs.readFile(created.privatePath), original);

    for (const algorithm of ['rsa', 'ecdsa']) {
      t.diagnostic('Generate ' + algorithm);
      const result = (
        await service.generate({
          ...options,
          name: algorithm,
          algorithm,
          bits: algorithm === 'rsa' ? 2048 : 256,
          passphrase: '',
          confirm: '',
          allowEmpty: true,
        })
      ).result;
      assert.equal(result.encrypted, false);
      for (const format of algorithm === 'rsa'
        ? ['RFC4716', 'PKCS8', 'PEM']
        : ['RFC4716', 'PKCS8']) {
        t.diagnostic('Export and import ' + algorithm + ' ' + format);
        const file = path.join(root, algorithm + '-' + format + '.pub');
        await fs.writeFile(file, await service.exportPublic(format));
        await service.selectFile(file);
        assert.equal((await service.inspect()).result.fingerprint, result.fingerprint);
      }
    }
    await service.selectFile(created.privatePath);
    await fs.appendFile(created.privatePath, '\n');
    await assert.rejects(service.inspect(options.passphrase), /changed/);
    const pending = service.generate({
      ...options,
      name: 'cancelled',
      algorithm: 'rsa',
      bits: 8192,
    });
    service.cancel();
    await assert.rejects(pending, /cancelled/);
    assert.equal(service.isBusy(), false);
    await assert.rejects(fs.access(path.join(root, 'cancelled')));
  },
);
