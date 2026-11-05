const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDrives, validateAction, identity } = require('../src/drives.cjs');
const { taskFor, fingerprint, runTask } = require('../src/flash.cjs');
const { createAdmin, workerScript } = require('../src/admin.cjs');
const disk = () => {
  const d = {
    number: 7,
    name: 'TEST USB',
    uniqueId: 'usb-test-123',
    serial: 'TEST-SERIAL',
    size: 16000000000,
    protected: false,
    partitions: [
      {
        number: 1,
        offset: 1048576,
        size: 15000000000,
        letter: 'X',
        label: 'TEST',
        protected: false,
      },
    ],
  };
  d.id = identity(d);
  return d;
};
test('drive actions reject protected, disconnected and malformed targets', () => {
  const d = disk();
  for (const bad of [
    { ...d, protected: true },
    { ...d, uniqueId: '' },
    { ...d, partitions: [{ ...d.partitions[0], protected: true }] },
  ])
    assert.throws(() => validateAction('drive-reset', { id: d.id }, [bad]));
  assert.throws(() => validateAction('drive-reset', { id: d.id }, []));
  assert.throws(() => validateAction('shell', { id: d.id }, [d]));
  assert.throws(() => validateAction('drive-letter', { id: d.id, partition: 1, letter: 'C' }, [d]));
  assert.throws(() =>
    validateAction('drive-label', { id: d.id, partition: 1, label: 'bad/path' }, [d]),
  );
});
test('drive erasure requires a one-use phrase and rechecks disk identity before dispatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-drives-test-'));
  let d = disk(),
    calls = [];
  const service = createDrives({
    settingsPath: path.join(root, 'settings.json'),
    inventoryFn: async () => [d],
    admin: {
      run: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
  });
  try {
    let p = await service.prepare('drive-reset', { id: d.id });
    await assert.rejects(service.execute(p.token, 'wrong'));
    await assert.rejects(service.execute(p.token, p.phrase));
    assert.equal(calls.length, 0);
    p = await service.prepare('drive-reset', { id: d.id });
    d = { ...d, number: 8 };
    await assert.rejects(service.execute(p.token, p.phrase), /changed/);
    assert.equal(calls.length, 0);
    p = await service.prepare('drive-reset', { id: d.id });
    await service.execute(p.token, p.phrase);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].number, 8);
    assert.equal(calls[0][1].erase, 'ERASE 8');
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('administrator helper accepts only enumerated operations and is off by default', async () => {
  const service = createAdmin();
  assert.equal(service.status().enabled, false);
  await assert.rejects(service.run('shell', {}), /Unsupported/);
  await assert.rejects(service.run('drive-format', {}), /shield/);
  const script = workerScript('test-pipe', 'test-token', 123);
  assert.ok(!script.includes('__PIPE__'));
  assert.ok(script.includes('Get-Disk'));
  assert.ok(script.includes('IsBoot'));
  assert.ok(script.includes('UniqueId'));
  assert.ok(!script.includes('Invoke-Expression'));
});
test('Automatic Flash validates tasks, fingerprints exact commands, and enforces target OS', async () => {
  const task = { schema: 1, name: 'Read only', platform: 'linux', script: 'printf hello' };
  assert.notEqual(fingerprint(task), fingerprint({ ...task, script: 'printf changed' }));
  assert.deepEqual(taskFor(JSON.stringify(task)), task);
  assert.throws(() => taskFor({ ...task, platform: 'anything' }));
  assert.throws(() => runTask(task, { platform: 'win32' }), /different/);
});
test('Automatic Flash runs a reviewed read-only task at normal privilege', async () => {
  const platform = process.platform;
  if (!['win32', 'linux', 'darwin'].includes(platform)) return;
  const result = await runTask(
    {
      schema: 1,
      name: 'Self-test',
      platform,
      script: platform === 'win32' ? "Write-Output 'OMNIA task test'" : "printf 'OMNIA task test'",
    },
    { directory: os.tmpdir() },
  );
  assert.match(result.output, /OMNIA task test/);
});
test(
  'helper authenticates, reports a rejected target and closes cleanly without elevation',
  { skip: process.platform !== 'win32' },
  async () => {
    const { spawn } = require('node:child_process');
    let child;
    const service = createAdmin({
      launch: (script) =>
        (child = spawn(
          path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          { windowsHide: true, stdio: 'ignore' },
        )),
    });
    try {
      await service.enable();
      assert.equal(service.status().enabled, true);
      await assert.rejects(service.run('drive-format', { number: -999, uniqueId: 'test' }));
      assert.equal(service.status().enabled, true);
      service.disable();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error('Helper failed to exit'));
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      assert.equal(service.status().enabled, false);
    } finally {
      service.close();
      child?.kill();
    }
  },
);
test('Automatic Flash authorizes an exact task and refuses changed USB instructions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-flash-test-'));
  const d = disk(),
    settingsPath = path.join(root, 'settings.json');
  const service = createDrives({
    settingsPath,
    inventoryFn: async () => [d],
    resolveDirectory: async () => root,
  });
  try {
    const task = {
      schema: 1,
      name: 'Read-only task',
      platform: process.platform,
      script:
        process.platform === 'win32' ? "Write-Output 'approved task'" : "printf 'approved task'",
    };
    let p = await service.prepare('flash-create', { id: d.id, partition: 1, task });
    await service.execute(p.token, '');
    assert.equal(service.view().actions[d.id], undefined);
    p = await service.prepare('flash-authorize', { id: d.id, partition: 1 });
    assert.deepEqual(p.task, task);
    await service.execute(p.token, '');
    const approved = JSON.parse(await fs.readFile(settingsPath, 'utf8'))[d.id];
    assert.equal(approved.hash, fingerprint(task));
    const result = await service.insertionTask(d, approved);
    assert.match(result.output, /approved task/);
    await fs.writeFile(
      path.join(root, 'AutomaticFlash.json'),
      JSON.stringify({ ...task, script: 'changed' }),
    );
    await assert.rejects(service.insertionTask(d, approved), /changed/);
    await service.configure(d.id, '');
    assert.equal(service.view().actions[d.id], undefined);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
