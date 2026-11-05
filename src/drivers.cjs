const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const documentation = {
  removal:
    'https://learn.microsoft.com/en-us/windows-hardware/drivers/install/using-device-manager-to-uninstall-devices-and-driver-packages',
  boot: 'https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/stop-error-7b-or-inaccessible-boot-device-troubleshooting',
  syntax:
    'https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax',
};
function riskFor(p, services) {
  const type = String(p.class).toLowerCase(),
    startup = services.filter((s) => ['Boot', 'System'].includes(s.startMode));
  if (p.bootCritical || startup.length)
    return {
      level: 'critical',
      reason:
        'Removing this driver may prevent Windows from starting. A driver backup alone may not be enough to recover the computer.',
      basis: p.bootCritical
        ? 'Windows reports this package as boot-critical.'
        : 'Linked startup services: ' +
          startup.map((s) => s.name + ' (' + s.startMode + ')').join(', ') +
          '.',
      documentation: 'boot',
    };
  if (['hdc', 'scsiadapter', 'diskdrive', 'volume'].includes(type))
    return {
      level: 'critical',
      reason:
        'This driver class handles storage. Removal may make disks inaccessible, interrupt file access or prevent Windows from starting.',
      basis:
        'Driver class: ' +
        p.class +
        '. This is a class-based risk assessment, not proof that this particular package is essential.',
      documentation: 'boot',
    };
  const reasons = {
    system:
      'System-class drivers can support core hardware. Removal may destabilize Windows or disable hardware.',
    firmware: 'Removal may affect device firmware management and future firmware updates.',
    securitydevices: 'Removal may interrupt security hardware and features that depend on it.',
    net: 'Removal may disconnect network adapters and interrupt internet or local-network access.',
    display: 'Removal may disable the display adapter, change resolution or interrupt the screen.',
    media: 'Removal may disable audio, microphones, cameras or other media devices.',
    audioendpoint: 'Removal may disable audio inputs or outputs.',
    hidclass: 'Removal may disable input devices or other human-interface controls.',
    keyboard: 'Removal may disable keyboards.',
    mouse: 'Removal may disable pointing devices.',
    usb: 'Removal may disconnect USB devices, including input devices and external storage.',
  };
  if (reasons[type])
    return {
      level: 'warning',
      reason: reasons[type],
      basis:
        'Driver class: ' +
        p.class +
        '. Actual effects depend on linked devices and available replacement drivers.',
      documentation: 'removal',
    };
  return {
    level: 'standard',
    reason:
      'Devices using this package may stop working if no suitable replacement driver is available.',
    basis: 'No device association or a stopped service does not prove a driver is unnecessary.',
    documentation: 'removal',
  };
}
const asArray = (value) => (Array.isArray(value) ? value : []);
async function inventory() {
  const script = await fs.readFile(path.join(__dirname, 'driver-inventory.ps1'), 'utf8');
  return new Promise((resolve, reject) =>
    execFile(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error)
          return reject(Error('Windows driver inventory failed or timed out. ' + error.message));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '')));
        } catch {
          reject(Error('Windows returned unreadable driver details.'));
        }
      },
    ),
  );
}
function normalize(raw, store) {
  const devices = asArray(raw.devices),
    services = asArray(raw.services),
    issues = asArray(raw.issues);
  const packages =
    store === null
      ? [
          ...new Map(
            devices
              .filter((d) => d.inf)
              .map((d) => [
                d.inf.toLowerCase(),
                {
                  inf: d.inf.toLowerCase(),
                  provider: d.provider,
                  version: d.version,
                  date: d.date,
                  class: d.class,
                },
              ]),
          ).values(),
        ]
      : asArray(store);
  return {
    devices,
    services,
    issues,
    completeStore: store !== null,
    packages: packages
      .map((p) => {
        const linked = devices.filter((d) => d.inf?.toLowerCase() === p.inf.toLowerCase());
        const linkedServices = services.filter((s) =>
          linked.some((d) => d.service?.toLowerCase() === s.name.toLowerCase()),
        );
        let protectedReason = '';
        if (!/^oem\d+\.inf$/i.test(p.inf) || p.inbox)
          protectedReason =
            'Built-in Windows package. This tool uses PnPUtil removal for third-party oem*.inf packages; built-in component removal is not supported here.';
        else if (store === null)
          protectedReason = 'Enable the shield and scan for complete package information';
        else if (
          issues.some((s) => s.startsWith('Device inventory:') || s.startsWith('Driver services:'))
        )
          protectedReason = 'Device or service inventory is incomplete';
        const usage = linked.some((d) => d.present === true)
          ? 'Connected devices'
          : linked.length
            ? linked.every((d) => d.present === false)
              ? 'Disconnected devices'
              : 'Device presence unknown'
            : 'No device association found';
        return {
          ...p,
          inf: p.inf.toLowerCase(),
          devices: linked,
          services: linkedServices,
          usage,
          protectedReason,
          risk: riskFor(p, linkedServices),
        };
      })
      .sort((a, b) => a.provider?.localeCompare(b.provider || '') || a.inf.localeCompare(b.inf)),
  };
}
function validatePackage(snapshot, inf) {
  if (typeof inf !== 'string' || !/^oem\d+\.inf$/.test(inf))
    throw Error('Select a third-party OEM driver package.');
  const item = snapshot?.packages.find((p) => p.inf === inf);
  if (!item) throw Error('The package is no longer in this scan.');
  if (item.protectedReason) throw Error(item.protectedReason);
  return item;
}
function fingerprint(item) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        item.inf,
        item.provider,
        item.version,
        item.class,
        item.bootCritical,
        item.inbox,
        item.risk,
        item.services.map((s) => [s.name, s.startMode]).sort((a, b) => a[0].localeCompare(b[0])),
        item.devices
          .map((d) => [d.id, d.present, d.service])
          .sort((a, b) => a[0].localeCompare(b[0])),
      ]),
    )
    .digest('hex');
}
/** Inspects driver packages and prepares single-use removal plans with backup locations. */
function createDrivers({
  admin,
  backupRoot,
  inventoryFn = inventory,
  platform = process.platform,
  hashFn,
  now = Date.now,
} = {}) {
  let snapshot = null,
    busy = false,
    lastResult = null;
  const plans = new Map();
  const hash =
    hashFn ||
    (async (inf) =>
      crypto
        .createHash('sha256')
        .update(await fs.readFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'INF', inf)))
        .digest('hex'));
  const status = () => ({ supported: platform === 'win32', busy, snapshot, lastResult });
  async function collect() {
    const raw = await inventoryFn();
    let store = null;
    if (admin.status().enabled) {
      const reply = await admin.run('driver-list', {});
      store = JSON.parse(reply.message);
    }
    snapshot = { ...normalize(raw, store), checkedAt: new Date(now()).toISOString() };
    return snapshot;
  }
  async function exclusive(fn) {
    if (platform !== 'win32') throw Error('Driver Inspector currently supports Windows.');
    if (busy) throw Error('A driver operation is already running.');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }
  async function refresh() {
    await exclusive(async () => {
      await collect();
      plans.clear();
    });
    return status();
  }
  async function prepare(action, inf) {
    return exclusive(async () => {
      if (!['driver-remove', 'driver-backup'].includes(action))
        throw Error('Unsupported driver action.');
      if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
      await collect();
      const item = validatePackage(snapshot, inf),
        token = crypto.randomUUID();
      const plan = {
        token,
        action,
        inf,
        item,
        identity: fingerprint(item),
        hash: await hash(inf),
        expires: now() + 120000,
        phrase: action === 'driver-remove' ? 'REMOVE ' + inf : '',
      };
      plans.clear();
      plans.set(token, plan);
      return { token, action, item, phrase: plan.phrase };
    });
  }
  async function execute(token, phrase, acknowledgedRisk = false) {
    return exclusive(async () => {
      const plan = plans.get(token);
      plans.delete(token);
      if (!plan || plan.expires < now())
        throw Error('Confirmation expired. Review the package again.');
      if (phrase !== plan.phrase) throw Error('The confirmation phrase does not match.');
      if (
        plan.action === 'driver-remove' &&
        plan.item.risk.level !== 'standard' &&
        acknowledgedRisk !== true
      )
        throw Error('Acknowledge the specific driver warning before removal.');
      if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
      await collect();
      const fresh = validatePackage(snapshot, plan.inf);
      if (fingerprint(fresh) !== plan.identity || (await hash(plan.inf)) !== plan.hash)
        throw Error('The driver or linked devices changed. Review the package again.');
      await fs.mkdir(backupRoot, { recursive: true });
      const backup = path.join(
        backupRoot,
        plan.inf.replace('.inf', '') + '-' + crypto.randomUUID(),
      );
      const reply = await admin.run(plan.action, {
        inf: plan.inf,
        hash: plan.hash,
        provider: fresh.provider,
        version: fresh.version,
        devices: [...new Set(fresh.devices.map((d) => d.id))],
        connected: [...new Set(fresh.devices.filter((d) => d.present === true).map((d) => d.id))],
        backup,
        phrase,
        acknowledgedRisk: acknowledgedRisk === true,
      });
      lastResult = JSON.parse(reply.message);
      plans.clear();
      snapshot = null;
      return lastResult;
    });
  }
  function location(kind, id) {
    if (kind === 'backup' && lastResult?.backup) return lastResult.backup;
    if (kind === 'package' && snapshot?.packages.some((p) => p.inf === id))
      return path.join(process.env.SystemRoot || 'C:\\Windows', 'INF', id);
    const service = kind === 'service' && snapshot?.services.find((s) => s.name === id);
    if (!service) throw Error('Scan and select an entry first.');
    let file = service.path
      .trim()
      .replace(/^"([^"]+)".*$/, '$1')
      .replace(/^\\\?\?\\/, '')
      .replace(/^\\SystemRoot\\/i, (process.env.SystemRoot || 'C:\\Windows') + '\\');
    if (/^system32\\/i.test(file)) file = path.join(process.env.SystemRoot || 'C:\\Windows', file);
    if (!/^[a-z]:\\.*\.(sys|dll|exe)$/i.test(file))
      throw Error('This service does not expose a recognizable local binary path.');
    return file;
  }
  return { status, refresh, prepare, execute, location, isBusy: () => busy };
}
module.exports = {
  inventory,
  normalize,
  validatePackage,
  fingerprint,
  createDrivers,
  riskFor,
  documentation,
};
