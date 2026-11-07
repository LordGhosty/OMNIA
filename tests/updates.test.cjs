const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../src/updates.cjs');
async function fixture(overrides = {}) {
  const emitter = new EventEmitter(),
    calls = [];
  emitter.quitAndInstall = (silent, restart) => {
    assert.equal(silent, true);
    assert.equal(restart, true);
    calls.push('install');
  };
  const update = createUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    window: { isDestroyed: () => false, webContents: { send() {} } },
    settings: { enabled: true, repository: 'fixture/omnia' },
    trust: {},
    platform: 'win32',
    automaticCheck: false,
    updaterFactory: () => emitter,
    isBusy: () => false,
    verify: async () => calls.push('verify'),
    recovery: { prepare: async () => calls.push('backup') },
    ...overrides,
  });
  await emitter.listeners('update-downloaded')[0]({ downloadedFile: 'fixture-setup.exe' });
  return { update, calls, emitter };
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

test('checking and downloading are single-flight and rejected requests remain retryable', async () => {
  const { update, emitter } = await fixture();
  let checks = 0;
  let downloads = 0;
  let fail;
  emitter.checkForUpdates = async () => {
    checks++;
    if (checks > 1) {
      emitter.emit('update-available', { version: '1.0.1' });
      return;
    }
    return new Promise((_resolve, reject) => {
      fail = reject;
    });
  };
  emitter.downloadUpdate = async () => {
    downloads++;
  };
  emitter.emit('update-not-available');
  await Promise.all([update('check'), update('check'), update('check')]);
  assert.equal(checks, 1);
  assert.equal((await update('status')).state, 'checking');
  fail(Error('Offline'));
  await new Promise(setImmediate);
  assert.equal((await update('status')).state, 'error');
  await update('check');
  assert.equal(checks, 2);
  assert.equal((await update('status')).state, 'available');
  await Promise.all([update('download'), update('download')]);
  assert.equal(downloads, 1);
  assert.equal((await update('status')).state, 'downloading');
  assert.equal(emitter.allowDowngrade, false);
  assert.equal(emitter.allowPrerelease, false);
  assert.equal(emitter.disableWebInstaller, true);
});

test('all active tool work blocks installation without consuming the downloaded update', async () => {
  const { update, calls } = await fixture({ isBusy: () => true });
  const result = await update('install');
  assert.match(result.message, /active tool operations/);
  assert.equal(result.state, 'downloaded');
  assert.deepEqual(calls, ['verify']);
});

test('repeated install clicks cannot prepare recovery or install twice', async () => {
  let finish;
  let backups = 0;
  const { update, calls } = await fixture({
    recovery: {
      prepare: () => {
        backups++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const first = update('install');
  await new Promise(setImmediate);
  await update('install');
  assert.equal(backups, 1);
  finish();
  await first;
  await new Promise(setImmediate);
  assert.equal(calls.filter((value) => value === 'install').length, 1);
  assert.equal((await update('status')).state, 'installing');
});

test('a synchronous installer failure becomes a visible error', async () => {
  const { update, emitter } = await fixture();
  emitter.quitAndInstall = () => {
    throw Error('Spawn failed');
  };
  await update('install');
  await new Promise(setImmediate);
  assert.equal((await update('status')).state, 'error');
});

test('update events do not send to a destroyed renderer', async () => {
  const { update } = await fixture({
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        send: () => {
          throw Error('Destroyed');
        },
      },
    },
  });
  assert.equal((await update('status')).state, 'downloaded');
});

test('disabled builds never contact the release feed', async () => {
  const update = createUpdates({
    app: { isPackaged: true, getVersion: () => '0.0.2' },
    window: { isDestroyed: () => true },
    settings: { enabled: false, repository: 'fixture/omnia' },
    updaterFactory: () => {
      throw Error('Unexpected updater');
    },
  });
  for (const action of ['status', 'check', 'download', 'install'])
    assert.equal((await update(action)).state, 'disabled');
});
