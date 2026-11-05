const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs/promises'),
  os = require('node:os');
const { fork } = require('node:child_process');
const { createProcessService } = require('../src/process-host.cjs');
const { createToolHost } = require('../src/tool-health.cjs');
function fixture(options = {}) {
  return createProcessService({
    kind: 'fixture',
    heartbeatMs: 500,
    startMs: 500,
    ...options,
    fork: () => {
      const child = fork(path.join(__dirname, 'fixtures/process-child.cjs'), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
      child.postMessage = (message) => child.send(message);
      return child;
    },
  });
}
test(
  'backend crash and infinite loop leave another tool callable',
  { timeout: 10000 },
  async (t) => {
    const faults = [],
      one = fixture({ onFault: (reason) => faults.push(reason) }),
      two = fixture(),
      hung = fixture();
    t.after(() => Promise.all([one.close(), two.close(), hung.close()]));
    assert.equal(one.pid, undefined);
    assert.equal(await one.echo('first'), 'first');
    await assert.rejects(one.crash(), /stopped/);
    assert.equal(await two.echo('still available'), 'still available');
    await assert.rejects(hung.hang(), /responding/);
    assert.equal(await two.echo(42), 42);
    assert.equal(faults.length, 1);
  },
);
test('a tool that never finishes loading cannot block the core', async (t) => {
  const service = fixture({ options: { hangStartup: true } });
  t.after(() => service.close());
  await assert.rejects(service.echo('unused'), /startup timed out/);
});
test('an unresolved call is bounded even while heartbeats continue', async (t) => {
  const service = fixture({ callMs: 150 });
  t.after(() => service.close());
  await assert.rejects(service.unresolved(), /timed out/);
});
test('quarantine survives restart for the same build and clears on an explicit reset', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-quarantine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { statePath: path.join(root, 'state.json'), buildId: 'one' };
  const first = createToolHost(() => {}, config);
  await first.register(['fixture'], () => ({ value: () => 42 }));
  first.fail(['fixture'], 'Fixture failure');
  const second = createToolHost(() => {}, config);
  let loaded = 0;
  const service = await second.register(['fixture'], () => {
    loaded++;
    return { value: () => 42 };
  });
  assert.equal(loaded, 0);
  assert.throws(() => service.value(), /unavailable/);
  await second.reset('fixture');
  assert.equal(service.value(), 42);
  first.fail(['fixture'], 'Fixture failure');
  const upgraded = createToolHost(() => {}, { ...config, buildId: 'two' });
  assert.equal(upgraded.has('fixture'), false);
});
