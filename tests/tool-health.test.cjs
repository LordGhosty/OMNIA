const test = require('node:test'),
  assert = require('node:assert/strict');
const { createToolHost } = require('../src/tool-health.cjs');
test('a failed service leaves other tools available', async () => {
  const host = createToolHost();
  await host.register(['broken'], () => {
    throw Error('Initialization failed');
  });
  const healthy = await host.register(['healthy'], () => ({ run: () => 42, isBusy: () => false }));
  assert.equal(healthy.run(), 42);
  assert.deepEqual(
    host.status().map((f) => f.id),
    ['broken'],
  );
});
test('unexpected errors quarantine only their service; normal validation errors do not', async () => {
  const host = createToolHost(),
    tool = await host.register(['one'], () => ({
      validate() {
        throw Error('Invalid input');
      },
      run() {
        throw TypeError('Broken code');
      },
    }));
  assert.throws(() => tool.validate());
  assert.equal(host.status().length, 0);
  assert.throws(() => tool.run());
  assert.equal(host.has('one'), true);
  assert.throws(() => tool.validate(), /unavailable/);
});
test('rejected asynchronous work is contained and reset uses a fresh service', async () => {
  const host = createToolHost();
  let creates = 0;
  const tool = await host.register(['one'], () => ({
    n: ++creates,
    run: async () => {
      if (creates === 1) throw TypeError('Failure');
      return creates;
    },
  }));
  await assert.rejects(tool.run());
  await host.reset('one');
  assert.equal(await tool.run(), 2);
  assert.equal(host.status().length, 0);
});
test('reset cannot interrupt an active mutation', async () => {
  const host = createToolHost();
  let closed = false;
  await host.register(['one'], () => ({
    isMutating: () => true,
    close: () => {
      closed = true;
    },
  }));
  host.quarantine(['one']);
  await assert.rejects(host.reset('one'), /finish/);
  assert.equal(closed, false);
});

test('page faults do not disable a shared backend and backend faults preserve cancellation', async () => {
  const host = createToolHost();
  let cancelled = false;
  const service = await host.register(['one', 'two'], () => ({
    run: () => {
      throw TypeError('Fixture fault');
    },
    cancel: () => {
      cancelled = true;
    },
  }));
  host.quarantine(['one']);
  assert.equal(host.blocked('two'), false);
  await host.reset('one');
  assert.throws(() => service.run());
  assert.equal(host.blocked('two'), true);
  service.cancel();
  assert.equal(cancelled, true);
});

test('failed media initialization leaves the directory and network service reachable', async (t) => {
  const { startServer } = require('../src/server.cjs');
  const host = createToolHost(),
    register = host.register;
  host.register = (ids, factory) =>
    register(
      ids,
      ids.includes('mp3')
        ? () => {
            throw Error('Fixture load failure');
          }
        : factory,
    );
  const server = await startServer({ toolHost: host });
  t.after(() => server.close());
  const auth = await fetch(server.desktopUrl, { redirect: 'manual' });
  const Cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await fetch(server.origin + '/launcher.html', { headers: { Cookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(server.origin + '/api/network/quick', { headers: { Cookie } })).status,
    403,
  );
  const networkAuth = await fetch(server.toolURL('network'), { redirect: 'manual' });
  const networkCookie = networkAuth.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await fetch(server.origin + '/api/network/quick', { headers: { Cookie: networkCookie } }))
      .status,
    200,
  );
  const mediaAuth = await fetch(server.toolURL('mp3'), { redirect: 'manual' });
  const mediaCookie = mediaAuth.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await fetch(server.origin + '/api/jobs', { headers: { Cookie: mediaCookie } })).status,
    503,
  );
});
