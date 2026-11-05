const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createNetworkService,
  target,
  subnet,
  diagnosticPlan,
  actionScript,
  speedTest,
} = require('../src/network.cjs');
const { startServer } = require('../src/server.cjs');
const snapshotFn = async () => ({
  platform: 'win32',
  actionsAvailable: true,
  hostname: 'test',
  adapters: [
    {
      name: 'Ethernet',
      index: 12,
      dhcp: true,
      addresses: [{ address: '192.0.2.10', family: 'IPv4', prefix: 24 }],
      gateways: ['192.0.2.1'],
      dns: ['192.0.2.1'],
    },
    { name: 'Static', index: 13, dhcp: false, addresses: [] },
  ],
  checkedAt: new Date().toISOString(),
});
test('global DNS actions prepare without an adapter inventory', async () => {
  let reads = 0;
  const service = createNetworkService({
    platform: 'win32',
    snapshotFn: async () => {
      reads++;
      return snapshotFn();
    },
  });
  for (const action of ['flush-dns', 'register-dns']) {
    const plan = await service.prepare(action);
    assert.equal(plan.adapter, null);
    assert.equal(plan.administrator, true);
  }
  assert.equal(reads, 0);
  await service.prepare('restart-adapter', 12);
  assert.equal(reads, 1);
  const unsupported = createNetworkService({ platform: 'linux', snapshotFn });
  await assert.rejects(unsupported.prepare('flush-dns'), /require Windows/);
});
async function finished(service) {
  for (let i = 0; i < 100; i++) {
    const job = service.view();
    if (job && !job.pending) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error('Timed out');
}
test('network targets and command plans cannot inject command arguments or scripts', () => {
  for (const value of ['example.com', '192.0.2.1', '2001:db8::1', 'localhost'])
    assert.equal(target(value), value);
  for (const value of [
    '-n 100',
    'example.com;whoami',
    '$(whoami)',
    'https://example.com/a',
    'host & dir',
    'a\nb',
    '..',
    'a..b',
  ])
    assert.throws(() => target(value));
  const plan = diagnosticPlan('ping', { target: 'example.com' });
  assert.equal(plan.args.at(-1), 'example.com');
  assert.ok(!plan.args.includes('cmd'));
  assert.throws(() => diagnosticPlan('shell', { target: 'whoami' }));
});
test('subnet calculator handles normal networks, point-to-point and single host prefixes', () => {
  assert.deepEqual(subnet('192.168.5.17/24'), {
    address: '192.168.5.17',
    prefix: 24,
    mask: '255.255.255.0',
    network: '192.168.5.0',
    broadcast: '192.168.5.255',
    first: '192.168.5.1',
    last: '192.168.5.254',
    total: 256,
    usable: 254,
  });
  assert.equal(subnet('10.0.0.0/31').usable, 2);
  assert.equal(subnet('10.0.0.1/32').first, '10.0.0.1');
  assert.equal(subnet('0.0.0.0/0').total, 4294967296);
  for (const input of ['1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4', '999.1.2.3/24', '1.2.3.4/24/x'])
    assert.throws(() => subnet(input));
});
test('network changes require a single-use confirmation for an existing DHCP adapter', async () => {
  const calls = [],
    service = createNetworkService({
      snapshotFn,
      actionFn: async (action, adapter) => {
        calls.push({ action, adapter });
        return { ok: true, output: 'Mock action complete' };
      },
    });
  assert.throws(() => service.execute('unapproved'));
  await assert.rejects(service.prepare('renew-dhcp', 13));
  await assert.rejects(service.prepare('renew-dhcp', 99));
  await assert.rejects(service.prepare('shell', 12));
  const plan = await service.prepare('renew-dhcp', 12);
  assert.equal(plan.adapter, 'Ethernet');
  assert.equal(calls.length, 0);
  service.execute(plan.id);
  assert.throws(() => service.execute(plan.id));
  assert.equal((await finished(service)).state, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].adapter.index, 12);
  await service.close();
});
test('elevated action scripts contain fixed commands and report over an ephemeral pipe', () => {
  const channel = 'omnia-network-12345678-1234-1234-1234-123456789abc';
  const script = actionScript('renew-dhcp', { index: 12 }, channel);
  assert.match(script, /InterfaceIndex 12/);
  assert.match(script, /NamedPipeClientStream/);
  assert.doesNotMatch(script, /WriteAllText|Invoke-Expression/);
  assert.throws(() => actionScript('renew-dhcp', { index: '12;whoami' }, channel));
  assert.throws(() => actionScript('flush-dns', null, 'path-to-file'));
});
test('cancellation stops a network operation and permits a later operation after cleanup', async () => {
  const service = createNetworkService({
    diagnoseFn: async (_kind, _input, signal) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('Cancelled.')), { once: true }),
      ),
  });
  service.start('ping', { target: 'localhost' });
  assert.throws(() => service.start('routes'));
  service.cancel();
  assert.equal((await finished(service)).state, 'cancelled');
  assert.equal(service.isBusy(), false);
  await service.close();
});
test('sustained speed test measures both directions with parallel transfers and average throughput', async () => {
  let active = 0,
    peak = 0;
  const sizes = [],
    job = {};
  const transport = async (url, options) => {
    const size = options.body?.length ?? Number(new URL(url).searchParams.get('bytes'));
    if (!size) return { bytes: 0, ms: 20 };
    active++;
    peak = Math.max(peak, active);
    sizes.push(size);
    await new Promise((resolve) => setTimeout(resolve, 12));
    active--;
    options.onBytes?.(size);
    return { bytes: options.body ? 0 : size, ms: 12 };
  };
  const result = await speedTest(job, new AbortController().signal, {
    transport,
    provider: 'cloudflare',
    phaseMs: 90,
    warmupMs: 12,
    capBytes: 80000000,
    requestSpacingMs: 0,
  });
  assert.equal(result.latencyMs, 20);
  assert.equal(result.jitterMs, 0);
  assert.equal(peak, 4);
  assert.ok(result.downloadMeasuredBytes > 0 && result.uploadMeasuredBytes > 0);
  assert.ok(
    Math.abs(
      result.downloadMbps - (result.downloadMeasuredBytes * 8) / result.downloadSeconds / 1e6,
    ) < 0.0001,
  );
  assert.ok(
    Math.abs(result.uploadMbps - (result.uploadMeasuredBytes * 8) / result.uploadSeconds / 1e6) <
      0.0001,
  );
  assert.ok(result.downloadBytes <= 80000000 && result.uploadBytes <= 80000000);
  assert.ok(sizes.every((n) => n <= 10000000));
  assert.equal(job.progress, 100);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(speedTest({}, controller.signal, { transport }), /Cancelled/);
});
test('speed-test failure stops other streams; cancelled measurements never report completion', async () => {
  let calls = 0;
  const transport = async (url, { signal }) => {
    if (url.endsWith('bytes=0')) return { ms: 10, bytes: 0 };
    calls++;
    if (calls === 1) throw Error('Service unavailable');
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(Error('Cancelled'));
      signal.addEventListener('abort', () => reject(Error('Cancelled')), { once: true });
    });
  };
  const job = {};
  await assert.rejects(
    speedTest(job, new AbortController().signal, {
      transport,
      provider: 'cloudflare',
      requestSpacingMs: 0,
    }),
    /Service unavailable/,
  );
  assert.notEqual(job.progress, 100);
  assert.equal(job.result.downloadMbps, null);
});
test('diagnostic controls are bounded and network changes target only validated adapters', async () => {
  for (const input of [{ count: 999 }, { hops: 99 }, { family: '4 & whoami' }])
    assert.throws(() => diagnosticPlan('ping', { target: 'localhost', ...input }));
  const plan = diagnosticPlan('ping', { target: 'localhost', count: 30, family: '4' });
  assert.ok(plan.args.includes('30'));
  assert.ok(plan.args.includes('-4'));
  const service = createNetworkService({ snapshotFn });
  await assert.rejects(service.prepare('dns-cloudflare', 999));
  for (const action of ['dns-cloudflare', 'dns-google', 'dns-auto', 'restart-adapter']) {
    const p = await service.prepare(action, 13);
    assert.equal(p.adapter, 'Static');
    const script = actionScript(
      action,
      { index: 13 },
      'omnia-network-12345678-1234-1234-1234-123456789abc',
    );
    assert.match(script, /13/);
    assert.doesNotMatch(script, /Invoke-Expression/);
    assert.throws(() =>
      actionScript(
        action,
        { index: '13;whoami' },
        'omnia-network-12345678-1234-1234-1234-123456789abc',
      ),
    );
  }
  await service.close();
});

test('network API requires authentication and CSRF headers, and never executes unconfirmed actions', async () => {
  let changes = 0;
  const server = await startServer({
    networkOptions: {
      snapshotFn,
      actionFn: async () => {
        changes++;
        return { ok: true };
      },
      publicFn: async () => ({ addresses: [], unavailable: ['IPv4', 'IPv6'] }),
    },
  });
  try {
    assert.equal((await fetch(server.origin + '/api/network/info')).status, 401);
    const cookie = (await fetch(server.toolURL('network'), { redirect: 'manual' })).headers
      .get('set-cookie')
      .split(';')[0];
    const request = (route, body, headers = {}) =>
      fetch(server.origin + route, {
        method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Omnia': '1', ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (await request('/api/network/run', { kind: 'public' }, { 'X-Omnia': '0' })).status,
      403,
    );
    assert.equal(
      (await request('/api/network/run', { kind: 'public' }, { Origin: 'https://example.com' }))
        .status,
      403,
    );
    assert.equal((await request('/api/network/action/execute', { id: 'no-token' })).status, 400);
    assert.equal(changes, 0);
    const info = await (await request('/api/network/info')).json();
    assert.equal(info.adapters[0].name, 'Ethernet');
    for (const route of ['/network', '/speed']) assert.equal((await request(route)).status, 200);
    assert.equal((await request('/api/sources?tool=network&name=x.mp4', {})).status, 403);
    assert.equal((await request('/api/network/run', { kind: 'arbitrary-command' })).status, 400);
  } finally {
    await server.close();
  }
});

test('LibreSpeed requests use whole download chunks and stay within the upload body limit', async () => {
  const uploadSizes = [],
    downloadSizes = [];
  const transport = async (url, options) => {
    if (!options.body && url.endsWith('empty.php')) return { ms: 12, bytes: 0 };
    const size = options.body?.length ?? Number(new URL(url).searchParams.get('ckSize')) * 1048576;
    if (options.body) uploadSizes.push(size);
    else downloadSizes.push(size);
    await new Promise((resolve) => setTimeout(resolve, 8));
    options.onBytes?.(size);
    return { ms: 8, bytes: options.body ? 0 : size };
  };
  const result = await speedTest({}, new AbortController().signal, {
    provider: 'frankfurt',
    transport,
    phaseMs: 30,
    warmupMs: 8,
    capBytes: 12000000,
  });
  assert.ok(uploadSizes.every((n) => n <= 1048576));
  assert.ok(downloadSizes.every((n) => n % 1048576 === 0));
  assert.ok(result.downloadBytes <= 12000000 && result.uploadBytes <= 12000000);
  assert.ok(result.downloadMbps > 0 && result.uploadMbps > 0);
});
