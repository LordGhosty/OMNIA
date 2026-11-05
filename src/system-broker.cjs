const path = require('node:path');
const crypto = require('node:crypto');
const { brokerAccess, readActions } = require('./access.cjs');
const titles = {
  'flush-dns': 'Clear DNS cache',
  'register-dns': 'Register DNS addresses',
  'renew-dhcp': 'Renew DHCP lease',
  'restart-adapter': 'Restart network adapter',
  'dns-cloudflare': 'Use Cloudflare DNS',
  'dns-google': 'Use Google DNS',
  'dns-auto': 'Use automatic DNS',
  'drive-label': 'Rename USB volume',
  'drive-letter': 'Change drive letter',
  'drive-format': 'Format USB volume',
  'drive-reset': 'Erase and repartition USB drive',
  'driver-backup': 'Back up driver package',
  'driver-remove': 'Remove driver package',
  'firewall-change': 'Change firewall rule',
  'repair-run': 'Run Windows maintenance',
};
function payloadFor(action, input, backupRoot) {
  const text = JSON.stringify(input || {});
  if (text.length > 16384) throw Error('System request is too large.');
  const data = JSON.parse(text);
  if (!data || Array.isArray(data) || typeof data !== 'object')
    throw Error('Invalid system request.');
  const checkText = (value) => {
    if (
      typeof value === 'string' &&
      (value.length > 2000 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value))
    )
      throw Error('System request contains unsupported text.');
    if (value && typeof value === 'object')
      for (const entry of Object.values(value)) checkText(entry);
  };
  checkText(data);
  if (action.startsWith('driver-') && action !== 'driver-list') {
    if (!/^oem\d+\.inf$/.test(data.inf || '') || !/^[a-f\d]{64}$/i.test(data.hash || ''))
      throw Error('Invalid driver identity.');
    data.backup = path.join(backupRoot, data.inf.replace('.inf', '') + '-' + crypto.randomUUID());
  }
  if (
    ['renew-dhcp', 'restart-adapter', 'dns-cloudflare', 'dns-google', 'dns-auto'].includes(action)
  ) {
    if (
      !Number.isInteger(data.index) ||
      data.index < 1 ||
      typeof data.guid !== 'string' ||
      !/^[{]?[a-f\d-]{36}[}]?$/i.test(data.guid)
    )
      throw Error('Invalid network adapter identity.');
  }
  if (
    action.startsWith('drive-') &&
    (!Number.isInteger(data.number) ||
      data.number < 0 ||
      typeof data.uniqueId !== 'string' ||
      !data.uniqueId ||
      !Number.isSafeInteger(data.size) ||
      data.size < 1)
  )
    throw Error('Invalid drive identity.');
  if (action === 'repair-run' && !require('./repair.cjs').tasks.some((t) => t.id === data.task))
    throw Error('Unknown maintenance task.');
  if (
    action === 'firewall-change' &&
    !['create', 'enable', 'disable', 'delete', 'edit', 'undo', 'undo-create'].includes(
      data.operation,
    )
  )
    throw Error('Unknown firewall operation.');
  if (action === 'firewall-change' && ['create', 'edit'].includes(data.operation))
    data.spec = require('./firewall.cjs').validateSpec(data.spec);
  if (
    action === 'firewall-change' &&
    (typeof data.name !== 'string' || !data.name || data.name.length > 512)
  )
    throw Error('Invalid firewall rule identity.');
  if (action === 'repair-run' && data.task === 'disk-check' && !/^[A-Z]:$/.test(data.volume || ''))
    throw Error('Select a Windows volume.');
  return data;
}
const clean = (value) =>
  String(value ?? '')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .slice(0, 2000);
function describe(action, data) {
  const rows = [];
  const add = (label, value) => {
    if (value !== undefined && value !== '') rows.push(label + ': ' + clean(value));
  };
  if (action.startsWith('driver-')) {
    add('Package', data.inf);
    add('Publisher', data.provider);
    add('Version', data.version);
    add('Backup', data.backup);
    if (action === 'driver-remove')
      rows.push('Removing a driver can disconnect hardware or prevent Windows from starting.');
  } else if (action.startsWith('drive-')) {
    add('Disk', data.number);
    add('Device identity', data.uniqueId);
    add('Serial', data.serial);
    add('Capacity (bytes)', data.size);
    add('Partition', data.partition);
    add('File system', data.fileSystem);
    add('Label', data.label);
    add('Drive letter', data.letter);
    if (['drive-format', 'drive-reset'].includes(action))
      rows.push('This erases data on the selected target.');
  } else if (action === 'firewall-change') {
    add('Operation', data.operation);
    add('Rule', data.name);
    for (const [key, value] of Object.entries(data.spec || {}))
      add(key.replace(/([A-Z])/g, ' $1'), Array.isArray(value) ? value.join(', ') : value);
  } else if (action === 'repair-run') {
    const task = require('./repair.cjs').tasks.find((t) => t.id === data.task);
    add('Task', task.name);
    add('Volume', data.volume);
    rows.push(task.description);
  } else {
    add('Adapter index', data.index);
    add('Adapter identity', data.guid);
  }
  return rows.join('\n');
}
/** Confirms exact system requests in the core, independently of tool-owned review dialogs. */
function createSystemBroker({ admin, confirm, isActive, backupRoot }) {
  let reviewing = false;
  return async (tool, action, input, progress) => {
    brokerAccess(tool, action);
    if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
    const data = payloadFor(action, input, backupRoot);
    if (readActions.has(action)) return admin.run(action, data, progress);
    if (reviewing || admin.status().busy) throw Error('Finish the current system request first.');
    if (!isActive(tool)) throw Error('Open this tool to confirm its system operation.');
    reviewing = true;
    try {
      if (!(await confirm({ tool, action, title: titles[action], detail: describe(action, data) })))
        throw Error('System operation cancelled.');
      if (!isActive(tool) || !admin.status().enabled)
        throw Error('System permission changed. Review the operation again.');
      return await admin.run(action, data, progress);
    } finally {
      reviewing = false;
    }
  };
}
module.exports = { createSystemBroker, payloadFor, describe };
