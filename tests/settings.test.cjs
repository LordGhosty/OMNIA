const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSettings, defaults } = require('../src/settings.cjs');
const { ipcAccess } = require('../src/access.cjs');

test('animation preferences persist independently and preserve subsettings when disabled', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json'),
    changes = [];
  const settings = await createSettings(file, (value) => changes.push(value));
  assert.deepEqual(settings.get(), defaults);
  await Promise.all([
    settings.update({ insignia: false }),
    settings.update({ transitions: false }),
  ]);
  await settings.update({ enabled: false, windowResize: false });
  const reopened = await createSettings(file);
  assert.deepEqual(reopened.get(), {
    enabled: false,
    insignia: false,
    transitions: false,
    details: true,
    windowResize: false,
  });
  await reopened.update({ enabled: true });
  assert.equal(reopened.get().insignia, false);
  assert.equal(reopened.get().transitions, false);
  assert.equal(changes.length, 3);
  const copy = settings.get();
  copy.details = false;
  assert.equal(settings.get().details, true);
});

test('invalid or oversized preference files recover without preventing startup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-settings-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  for (const value of ['{invalid', ' '.repeat(5000), 'null']) {
    await fs.writeFile(file, value);
    assert.deepEqual((await createSettings(file)).get(), defaults);
  }
  await fs.writeFile(file, JSON.stringify({ enabled: false, insignia: 'false', unrelated: true }));
  const settings = await createSettings(file);
  assert.deepEqual(settings.get(), { ...defaults, enabled: false });
  for (const patch of [
    null,
    [],
    {},
    { enabled: 1 },
    { path: 'elsewhere' },
    { enabled: true, admin: true },
  ])
    await assert.rejects(settings.update(patch), /Unsupported/);
  assert.equal(settings.get().enabled, false);
});

test('failed preference writes keep the last saved state and allow retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-settings-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const settings = await createSettings(file);
  await fs.mkdir(file + '.tmp');
  await assert.rejects(settings.update({ enabled: false }));
  assert.equal(settings.get().enabled, true);
  await fs.rmdir(file + '.tmp');
  await settings.update({ enabled: false });
  assert.equal(settings.get().enabled, false);
});

test('known tools can change appearance but cannot route settings into another renderer', () => {
  for (const id of ['home', 'mp3', 'firewall']) {
    assert.doesNotThrow(() => ipcAccess(id, 'settings', 'get'));
    assert.doesNotThrow(() => ipcAccess(id, 'settings', 'update', { enabled: false }));
  }
  assert.doesNotThrow(() => ipcAccess('home', 'settings', 'open'));
  assert.throws(() => ipcAccess('mp3', 'settings', 'open'));
  assert.throws(() => ipcAccess('mp3', 'settings', 'cover'));
  assert.throws(() => ipcAccess('mp3', 'settings', 'uncover'));
  assert.throws(() => ipcAccess('unknown', 'settings', 'update', { enabled: false }));
});
