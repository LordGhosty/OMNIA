const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { createDiskSpace } = require('../src/diskspace.cjs'),
  { validateSpec, createFirewall } = require('../src/firewall.cjs'),
  { createRepair } = require('../src/repair.cjs');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const spec = () => ({
  displayName: 'Fixture rule',
  direction: 'Inbound',
  action: 'Block',
  protocol: 'TCP',
  profiles: ['Private'],
  localPort: '443',
  remotePort: 'Any',
  program: 'Any',
  remoteAddress: 'LocalSubnet',
});
test('disk scan counts exact logical bytes, hard links once, skips links and lists multiple disks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-disk-fixture-'));
  let service;
  try {
    await fs.mkdir(path.join(root, 'folder'));
    await fs.writeFile(path.join(root, 'image.png'), Buffer.alloc(400));
    await fs.writeFile(path.join(root, 'folder', 'video.mp4'), Buffer.alloc(600));
    await fs.link(path.join(root, 'image.png'), path.join(root, 'copy.png'));
    await fs.symlink(
      root,
      path.join(root, 'loop'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const inventory = {
      disks: [{ number: 0 }, { number: 2 }],
      volumes: [
        { id: 'first', root },
        { id: 'second', root },
      ],
      issues: [],
    };
    service = createDiskSpace({ platform: 'win32', inventoryFn: async () => inventory });
    await service.refresh();
    assert.equal(service.status().inventory.disks.length, 2);
    await service.start(root);
    for (let i = 0; i < 200 && service.status().scan.phase === 'scanning'; i++) await pause(10);
    const result = service.status().scan;
    assert.equal(result.phase, 'complete');
    assert.equal(result.bytes, 1000);
    assert.equal(result.hardlinks, 1);
    assert.equal(result.links, 1);
    assert.equal(result.categories.images, 400);
    assert.equal(result.categories.video, 600);
    const table = await service.query(0);
    assert.equal(table.total, 3);
    const folder = table.rows.find((n) => n.name === 'folder');
    assert.equal(folder.bytes, 600);
    assert.equal((await service.query(folder.id)).rows[0].bytes, 600);
    assert.equal(await service.query(folder.id, 0, 'size', true), path.join(root, 'folder'));
    await assert.rejects(service.query(999), /no longer/);
    await assert.rejects(service.startVolume('missing'), /no accessible/);
    await service.close();
    assert.equal(service.status().scan, null);
    await fs.stat(path.join(root, 'image.png'));
  } finally {
    await service?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('disk scan reports bounded partial coverage instead of a false complete result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-scan-limit-')),
    service = createDiskSpace({ limit: 5 });
  try {
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(root, i + '.txt'), 'abc');
    await service.start(root);
    for (let i = 0; i < 200 && service.status().scan.phase === 'scanning'; i++) await pause(10);
    assert.equal(service.status().scan.phase, 'limited');
    assert.equal(service.status().scan.bytes, 12);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('firewall scope validation rejects broad unscoped rules and malformed arguments', () => {
  assert.deepEqual(validateSpec(spec()), spec());
  assert.equal(
    validateSpec({ ...spec(), remoteAddress: '192.0.2.0/24,2001:db8::/32' }).profiles[0],
    'Private',
  );
  for (const patch of [
    { localPort: 'Any' },
    { localPort: '443;whoami' },
    { localPort: '65536' },
    { localPort: '100-20' },
    { protocol: 'Any' },
    { remoteAddress: 'https://example.com' },
    { remoteAddress: '1.2.3.4/33' },
    { remoteAddress: 'Any;whoami' },
    { program: 'C:\\app.exe";whoami' },
    { profiles: ['All'] },
    { displayName: 'bad\nname' },
  ])
    assert.throws(() => validateSpec({ ...spec(), ...patch }));
});
test('firewall plans are one-use, journaled and undo uses the recorded identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-fw-test-')),
    calls = [];
  let enabled = true,
    local = true;
  const admin = {
    status: () => ({ enabled }),
    run: async (action, data) => {
      calls.push({ action, data });
      return {
        message: JSON.stringify(
          action === 'firewall-list'
            ? { rules: [{ name: 'fixture' }], profiles: [] }
            : action === 'firewall-detail'
              ? { local, hash: 'before', values: { name: 'fixture' } }
              : {
                  operation: data.operation,
                  name: data.name,
                  after: 'after',
                  backup: 'OMNIA-BACKUP-fixture',
                  backupHash: 'saved',
                  wasEnabled: 'True',
                },
        ),
      };
    },
  };
  const service = createFirewall({
    admin,
    journalPath: path.join(root, 'journal.json'),
    platform: 'win32',
  });
  try {
    let plan = await service.prepare('create', { spec: spec() });
    await service.execute(plan.token);
    await assert.rejects(service.execute(plan.token), /expired/);
    assert.equal(calls.filter((c) => c.action === 'firewall-change').length, 1);
    const record = JSON.parse(await fs.readFile(path.join(root, 'journal.json')))[0];
    assert.equal(record.pending, false);
    plan = await service.prepare('undo', { id: record.id });
    await service.execute(plan.token);
    assert.equal(calls.at(-1).data.operation, 'undo-create');
    assert.equal(calls.at(-1).data.expected, 'after');
    local = false;
    await assert.rejects(service.prepare('delete', { name: 'fixture' }), /read-only/);
    enabled = false;
    await assert.rejects(service.prepare('create', { spec: spec() }), /shield/);
    assert.equal(calls.filter((c) => c.action === 'firewall-change').length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('Windows Repair streams bounded output, rejects unknown commands and records exit codes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-repair-test-'));
  let finish, payload;
  const admin = {
    status: () => ({ enabled: true }),
    run: async (action, data, progress) => {
      assert.equal(action, 'repair-run');
      payload = data;
      progress('Checking fixture…\n');
      return new Promise((resolve) => (finish = resolve));
    },
  };
  const service = createRepair({
    admin,
    platform: 'win32',
    reportPath: path.join(root, 'report.json'),
    inventoryFn: async () => ({ volumes: [{ id: 'volume', root: 'D:\\', size: 100 }] }),
  });
  try {
    await assert.rejects(service.prepare('shell'), /Unsupported/);
    await assert.rejects(service.prepare('disk-check', 'missing'), /Select/);
    const plan = await service.prepare('disk-check', 'volume');
    assert.equal(plan.command, 'chkdsk D:');
    await service.execute(plan.token);
    assert.equal(payload.volume, 'D:');
    assert.equal(payload.volumeId, 'volume');
    assert.equal(service.isBusy(), true);
    assert.match(service.status().job.output, /Checking fixture/);
    await assert.rejects(service.prepare('sfc-check'), /Wait/);
    finish({
      message: JSON.stringify({
        steps: [{ command: 'chkdsk D:', exitCode: 1 }],
        restartRequired: false,
      }),
    });
    for (let i = 0; i < 100 && service.isBusy(); i++) await pause(10);
    assert.equal(service.status().job.state, 'attention');
    for (let i = 0; i < 100; i++) {
      try {
        assert.equal(
          JSON.parse(await fs.readFile(path.join(root, 'report.json'))).result.steps[0].exitCode,
          1,
        );
        break;
      } catch (e) {
        if (i === 99) throw e;
        await pause(10);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test(
  'PowerShell firewall and repair files parse and preserve guarded operations',
  { skip: process.platform !== 'win32' },
  async () => {
    const { promisify } = require('node:util'),
      exec = promisify(require('node:child_process').execFile);
    const script = `$ErrorActionPreference='Stop';$files=@('src/firewall-commands.ps1','src/repair-commands.ps1','src/storage-inventory.ps1');foreach($file in $files){$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|Out-String)}};'parsed'`;
    const { stdout } = await exec(
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true },
    );
    assert.match(stdout, /parsed/);
  },
);

test(
  'native repair and firewall mutations are exercised only through command fixtures',
  { skip: process.platform !== 'win32' },
  async () => {
    const exec = require('node:util').promisify(require('node:child_process').execFile);
    for (const tool of ['firewall', 'repair']) {
      const { stdout } = await exec(
        path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, tool + '-helper.ps1'),
          '-Source',
          path.join(__dirname, '../src', tool + '-commands.ps1'),
        ],
        { windowsHide: true, timeout: 20000 },
      );
      assert.match(stdout, /passed with simulated commands/);
    }
  },
);

test('cancelled disk scans remain partial and can be cleared without touching files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-scan-cancel-')),
    service = createDiskSpace();
  try {
    for (let i = 0; i < 30; i++) await fs.writeFile(path.join(root, i + '.txt'), 'data');
    await service.start(root);
    service.cancel();
    for (let i = 0; i < 200 && service.status().scan.phase === 'scanning'; i++) await pause(10);
    assert.equal(service.status().scan.phase, 'cancelled');
    await service.close();
    assert.equal((await fs.readdir(root)).length, 30);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
