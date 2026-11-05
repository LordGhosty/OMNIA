const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalize, validatePackage, createDrivers } = require('../src/drivers.cjs');
const raw = () => ({
  devices: [
    {
      id: 'DEVICE-1',
      name: 'Test device',
      inf: 'oem12.inf',
      provider: 'Test publisher',
      version: '1',
      class: 'Net',
      present: false,
      service: 'example',
    },
  ],
  services: [
    {
      name: 'example',
      state: 'Stopped',
      startMode: 'Manual',
      path: 'C:\\Windows\\System32\\drivers\\example.sys',
    },
  ],
  issues: [],
});
const store = () => [
  {
    inf: 'oem12.inf',
    provider: 'Test publisher',
    version: '1',
    class: 'Net',
    bootCritical: false,
    inbox: false,
  },
  {
    inf: 'oem13.inf',
    provider: 'Old package',
    version: '1',
    class: 'Media',
    bootCritical: false,
    inbox: false,
  },
];
test('driver inventory distinguishes disconnected, unassociated, unknown and protected packages', () => {
  const data = raw();
  let result = normalize(data, store());
  assert.equal(result.packages.find((p) => p.inf === 'oem12.inf').usage, 'Disconnected devices');
  assert.equal(
    result.packages.find((p) => p.inf === 'oem13.inf').usage,
    'No device association found',
  );
  assert.equal(result.completeStore, true);
  assert.equal(validatePackage(result, 'oem13.inf').protectedReason, '');
  data.devices[0].present = null;
  assert.equal(
    normalize(data, store()).packages.find((p) => p.inf === 'oem12.inf').usage,
    'Device presence unknown',
  );
  data.devices[0].present = true;
  assert.equal(
    normalize(data, store()).packages.find((p) => p.inf === 'oem12.inf').usage,
    'Connected devices',
  );
  assert.throws(
    () => validatePackage(normalize(raw(), [{ ...store()[0], inbox: true }]), 'oem12.inf'),
    /Built-in/,
  );
  for (const p of [
    { ...store()[0], bootCritical: true },
    { ...store()[0], class: 'SCSIAdapter' },
  ])
    assert.equal(validatePackage(normalize(raw(), [p]), p.inf).risk.level, 'critical');
  data.services[0].startMode = 'Boot';
  assert.equal(validatePackage(normalize(data, store()), 'oem12.inf').risk.level, 'critical');
  assert.throws(() => validatePackage(normalize(raw(), null), 'oem12.inf'), /shield/);
  data.issues = ['Device inventory: failed'];
  assert.throws(() => validatePackage(normalize(data, store()), 'oem13.inf'), /incomplete/);
  for (const id of ['../oem12.inf', 'oem12.inf /force', 'C:\\evil.inf', 'machine.inf'])
    assert.throws(() => validatePackage(result, id));
});
test('driver removal requires a single-use confirmation, fresh device identity and package hash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-driver-test-'));
  let data = raw(),
    packages = store(),
    hash = 'a'.repeat(64),
    enabled = true;
  const calls = [];
  const admin = {
    status: () => ({ enabled }),
    run: async (action, input) => {
      calls.push({ action, input });
      return {
        message: JSON.stringify(
          action === 'driver-list'
            ? packages
            : { action, inf: input.inf, backup: input.backup, exitCode: 0 },
        ),
      };
    },
  };
  const service = createDrivers({
    admin,
    backupRoot: root,
    platform: 'win32',
    inventoryFn: async () => structuredClone(data),
    hashFn: async () => hash,
  });
  try {
    await service.refresh();
    assert.equal(service.status().busy, false);
    let plan = await service.prepare('driver-remove', 'oem12.inf');
    await assert.rejects(service.execute(plan.token, 'wrong'), /phrase/);
    await assert.rejects(service.execute(plan.token, plan.phrase, true), /expired/);
    plan = await service.prepare('driver-remove', 'oem12.inf');
    data.devices[0].id = 'DEVICE-CHANGED';
    await assert.rejects(service.execute(plan.token, plan.phrase, true), /changed/);
    plan = await service.prepare('driver-remove', 'oem12.inf');
    hash = 'b'.repeat(64);
    await assert.rejects(service.execute(plan.token, plan.phrase, true), /changed/);
    plan = await service.prepare('driver-remove', 'oem12.inf');
    packages[0].bootCritical = true;
    await assert.rejects(service.execute(plan.token, plan.phrase, true), /changed/);
    packages = store();
    plan = await service.prepare('driver-remove', 'oem12.inf');
    await assert.rejects(service.execute(plan.token, plan.phrase), /Acknowledge/);
    assert.equal(calls.filter((c) => c.action === 'driver-remove').length, 0);
    plan = await service.prepare('driver-remove', 'oem12.inf');
    const result = await service.execute(plan.token, plan.phrase, true);
    assert.equal(result.action, 'driver-remove');
    assert.equal(service.status().snapshot, null);
    assert.equal(calls.filter((c) => c.action === 'driver-remove').length, 1);
    assert.ok(result.backup.startsWith(root + path.sep));
    await assert.rejects(service.execute(plan.token, plan.phrase, true), /expired/);
    packages[0].bootCritical = true;
    plan = await service.prepare('driver-remove', 'oem12.inf');
    await service.execute(plan.token, plan.phrase, true);
    assert.equal(calls.at(-1).input.acknowledgedRisk, true);
    plan = await service.prepare('driver-backup', 'oem12.inf');
    await service.execute(plan.token, '');
    assert.equal(calls.at(-1).action, 'driver-backup');
    enabled = false;
    await assert.rejects(service.prepare('driver-remove', 'oem12.inf'), /shield/);
    await assert.rejects(service.prepare('shell', 'oem12.inf'), /Unsupported/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('driver confirmation expires and overlapping scans are rejected', async () => {
  let now = 1000,
    release;
  const admin = {
    status: () => ({ enabled: true }),
    run: async () => ({ message: JSON.stringify(store()) }),
  };
  const service = createDrivers({
    admin,
    platform: 'win32',
    inventoryFn: async () => raw(),
    hashFn: async () => 'a'.repeat(64),
    now: () => now,
  });
  const plan = await service.prepare('driver-backup', 'oem12.inf');
  now += 120001;
  await assert.rejects(service.execute(plan.token, ''), /expired/);
  const waiting = createDrivers({
    admin,
    platform: 'win32',
    inventoryFn: () => new Promise((resolve) => (release = resolve)),
  });
  const scan = waiting.refresh();
  await assert.rejects(waiting.refresh(), /already running/);
  release(raw());
  await scan;
  const other = createDrivers({ admin, platform: 'linux' });
  await assert.rejects(other.refresh(), /Windows/);
});
test('administrator helper stays within the Windows command limit and parses all driver guards', async () => {
  const script = require('../src/admin.cjs').workerScript(
    'omnia-' + 'a'.repeat(36),
    'b'.repeat(64),
    123456,
  );
  assert.ok(
    Buffer.from(require('../src/admin.cjs').launchScript(script), 'utf16le').toString('base64')
      .length +
      1000 <
      30000,
  );
  assert.ok(script.includes('Invoke-OmniaDriver'));
  assert.ok(!script.includes('__DRIVER_ACTIONS__'));
  assert.ok(script.includes('/export-driver'));
  assert.ok(script.includes('/delete-driver'));
  assert.ok(!script.includes('/force'));
  assert.ok(!script.includes('/reboot'));
});

test(
  'PowerShell removal helper verifies the backup before invoking simulated deletion',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-driver-helper-'));
    try {
      const { promisify } = require('node:util'),
        exec = promisify(require('node:child_process').execFile);
      const { stdout } = await exec(
        path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'driver-helper.ps1'),
          '-Root',
          root,
          '-Source',
          path.join(__dirname, '../src/driver-admin.ps1'),
        ],
        { windowsHide: true, timeout: 20000 },
      );
      assert.match(stdout, /passed with simulated commands/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
