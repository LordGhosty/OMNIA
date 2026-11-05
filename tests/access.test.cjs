const test = require('node:test'),
  assert = require('node:assert/strict');
const { createSessions, ipcAccess, brokerAccess } = require('../src/access.cjs');
const { startServer } = require('../src/server.cjs');
const { createSystemBroker } = require('../src/system-broker.cjs');
test('sessions bind identities independently of supplied tool labels', () => {
  const sessions = createSessions();
  assert.equal(sessions.identify(sessions.cookie('mp3') + '; omnia_tool=network'), 'mp3');
  assert.equal(sessions.identify(sessions.cookie('mp3') + '; ' + sessions.cookie('network')), null);
  assert.equal(sessions.redeem(sessions.launch('mp3')), 'mp3');
  assert.equal(sessions.redeem('forged'), undefined);
  assert.notEqual(sessions.cookie('mp3'), sessions.cookie('network'));
});
test('media and speed sessions cannot cross into network changes', async (t) => {
  const reached = [];
  const server = await startServer({
    remoteNetwork: {
      isBusy: () => false,
      close: async () => {},
      forTool: (tool) => ({
        quick: async () => {
          reached.push(tool);
          return {};
        },
        prepare: async () => {
          throw Error('Forbidden operation reached');
        },
      }),
    },
  });
  t.after(() => server.close());
  const auth = async (tool) =>
    (await fetch(server.toolURL(tool), { redirect: 'manual' })).headers
      .get('set-cookie')
      .split(';')[0];
  const request = (cookie, route, body) =>
    fetch(server.origin + route, {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, 'X-Omnia': '1', 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  const mp3 = await auth('mp3'),
    speed = await auth('speed'),
    network = await auth('network');
  for (const cookie of [mp3, mp3 + '; omnia_tool=network'])
    assert.equal((await request(cookie, '/api/network/quick')).status, 403);
  assert.equal(
    (await request(speed, '/api/network/action/prepare', { action: 'flush-dns' })).status,
    403,
  );
  assert.equal((await request(speed, '/api/network/run', { kind: 'routes' })).status, 403);
  assert.equal((await request(network, '/api/network/quick')).status, 200);
  assert.deepEqual(reached, ['network']);
  const url = new URL(server.toolURL('mp3'));
  url.searchParams.set('tool', 'network');
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 403);
});
test('IPC permissions include operation and result ownership', () => {
  assert.throws(() => ipcAccess('images', 'files', 'save', null));
  assert.throws(() => ipcAccess('mp3', 'admin', 'enable'));
  assert.throws(() => ipcAccess('speed', 'admin', 'enable'));
  assert.throws(() => ipcAccess('search', 'file-tools', 'rename', { tool: 'search' }));
  assert.throws(() =>
    ipcAccess('search', 'file-tools', 'execute', { tool: 'search', token: 'x' }, () => 'rename'),
  );
  assert.throws(() => ipcAccess('images', 'files', 'save', { id: 'x' }, () => 'metadata'));
  assert.throws(() =>
    ipcAccess('images', 'files', 'save-batch', { ids: ['a', 'b'] }, (id) =>
      id === 'a' ? 'images' : 'metadata',
    ),
  );
  assert.throws(() => ipcAccess('images', 'tool-health', 'reset', { id: 'drivers' }));
  assert.doesNotThrow(() => ipcAccess('images', 'files', 'save', { id: 'x' }, () => 'images'));
  assert.doesNotThrow(() => ipcAccess('network', 'admin', 'enable'));
  assert.throws(() => brokerAccess('speed', 'flush-dns'));
  assert.throws(() => brokerAccess('search', 'trash'));
});

test('duplicate removal consumes only paths from a core-confirmed plan', async () => {
  const { createTrashReview } = require('../src/trash-review.cjs');
  const path = require('node:path');
  const file = path.resolve('fixture-copy.txt'),
    other = path.resolve('fixture-other.txt');
  const removed = [];
  let permit = false;
  const review = createTrashReview({
    remove: async (file) => removed.push(file),
    confirm: async () => permit,
    isActive: () => true,
  });
  await assert.rejects(review.remove(file), /not approved/);
  const plan = { token: 'review', rows: [{ from: file }] };
  review.remember(plan);
  await assert.rejects(
    review.execute(plan.token, () => review.remove(file)),
    /cancelled/,
  );
  assert.deepEqual(removed, []);
  permit = true;
  review.remember(plan);
  plan.rows[0].from = other;
  await review.execute(plan.token, async () => {
    await assert.rejects(review.remove(other), /not approved/);
    await review.remove(file);
    await assert.rejects(review.remove(file), /not approved/);
  });
  await assert.rejects(
    review.execute(plan.token, () => {}),
    /Review/,
  );
  assert.deepEqual(removed, [file]);
});
test('core broker requires trusted confirmation and preserves the reviewed request', async () => {
  const calls = [];
  let active = true,
    permit = false;
  const input = { index: 4, guid: '12345678-1234-1234-1234-123456789abc' };
  const broker = createSystemBroker({
    admin: {
      status: () => ({ enabled: true }),
      run: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
    isActive: () => active,
    backupRoot: 'C:\\fixture',
    confirm: async () => {
      input.index = 99;
      return permit;
    },
  });
  await assert.rejects(broker('speed', 'restart-adapter', input), /cannot access/);
  await assert.rejects(broker('network', 'restart-adapter', input), /cancelled/);
  assert.equal(calls.length, 0);
  input.index = 4;
  permit = true;
  await broker('network', 'restart-adapter', input);
  assert.equal(calls[0][1].index, 4);
  active = false;
  await assert.rejects(broker('network', 'flush-dns', {}), /Open this tool/);
  assert.equal(calls.length, 1);
});
