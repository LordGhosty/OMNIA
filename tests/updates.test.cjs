const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../src/updates.cjs');
async function fixture(overrides = {}) {
  const emitter = new EventEmitter(),
    calls = [];
  emitter.quitAndInstall = () => calls.push('install');
  const update = createUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    window: { isDestroyed: () => false, webContents: { send() {} } },
    settings: { enabled: true, repository: 'fixture/omnia' },
    platform: 'win32',
    automaticCheck: false,
    updaterFactory: () => emitter,
    isBusy: () => false,
    verify: async () => calls.push('verify'),
    recovery: { prepare: async () => calls.push('backup') },
    ...overrides,
  });
  await emitter.listeners('update-downloaded')[0]({ downloadedFile: 'fixture-setup.exe' });
  return { update, calls };
}
test('update installation verifies both sides of recovery preparation', async () => {
  const { update, calls } = await fixture();
  await update('install');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['verify', 'verify', 'backup', 'verify', 'install']);
});
test('failed recovery or invalid publisher never launches the installer', async () => {
  for (const overrides of [
    {
      recovery: {
        prepare: async () => {
          throw Error('Backup unavailable');
        },
      },
    },
    {
      verify: async () => {
        throw Error('Invalid publisher');
      },
    },
  ]) {
    const { update, calls } = await fixture(overrides);
    await update('install');
    await new Promise(setImmediate);
    assert.equal(calls.includes('install'), false);
    assert.equal((await update('status')).state, 'error');
  }
});
test('an operation starting during recovery postpones installation', async () => {
  let busy = false;
  const { update, calls } = await fixture({
    isBusy: () => busy,
    recovery: {
      prepare: async () => {
        busy = true;
      },
    },
  });
  await update('install');
  await new Promise(setImmediate);
  assert.equal(calls.includes('install'), false);
  assert.equal((await update('status')).state, 'downloaded');
});
