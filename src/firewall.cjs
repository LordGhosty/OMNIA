const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  net = require('node:net');
const { readSource } = require('./system-read.cjs');
function validateSpec(s) {
  if (
    !s ||
    typeof s.displayName !== 'string' ||
    !s.displayName.trim() ||
    s.displayName.length > 120 ||
    /[\x00-\x1f]/.test(s.displayName)
  )
    throw Error('Enter a rule name of 1–120 characters.');
  for (const [key, values] of Object.entries({
    direction: ['Inbound', 'Outbound'],
    action: ['Allow', 'Block'],
  }))
    if (!values.includes(s[key])) throw Error('Choose a valid ' + key + '.');
  if (
    !['TCP', 'UDP', 'Any', 'ICMPv4', 'ICMPv6'].includes(s.protocol) &&
    !(typeof s.protocol === 'string' && /^(0|[1-9]\d{0,2})$/.test(s.protocol) && +s.protocol <= 255)
  )
    throw Error('Choose a protocol or enter its number from 0 to 255.');
  if (
    !Array.isArray(s.profiles) ||
    !s.profiles.length ||
    s.profiles.length > 3 ||
    s.profiles.some((p) => !['Domain', 'Private', 'Public'].includes(p))
  )
    throw Error('Choose at least one network profile.');
  for (const key of ['localPort', 'remotePort']) {
    if (typeof s[key] !== 'string' || s[key].length > 200) throw Error('Enter ports or Any.');
    if (s[key] !== 'Any') {
      if (!['TCP', 'UDP', '6', '17'].includes(s.protocol)) throw Error('Ports require TCP or UDP.');
      for (const range of s[key].split(',')) {
        if (!/^\d{1,5}(-\d{1,5})?$/.test(range))
          throw Error('Use ports or comma-separated port ranges.');
        const [a, b = Number(range)] = range.split('-').map(Number);
        if (a < 1 || a > 65535 || b < a || b > 65535)
          throw Error('Ports must be between 1 and 65535.');
      }
    }
  }
  if (
    typeof s.program !== 'string' ||
    s.program.length > 1024 ||
    (s.program !== 'Any' && !/^[a-z]:\\[^*?"\r\n]+\.exe$/i.test(s.program))
  )
    throw Error('Choose a local executable or Any.');
  for (const key of ['remoteAddress', 'localAddress']) {
    if (key === 'localAddress' && s[key] === undefined) continue;
    if (typeof s[key] !== 'string' || !s[key] || s[key].length > 1000)
      throw Error('Enter an address scope.');
    for (const a of s[key].split(',')) {
      if (['Any', 'LocalSubnet'].includes(a)) continue;
      const [ip, bits, ...extra] = a.split('/'),
        family = net.isIP(ip);
      if (
        !family ||
        extra.length ||
        (bits !== undefined &&
          (!/^\d{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))
      )
        throw Error('Use IP addresses, CIDR subnets, Any or LocalSubnet.');
    }
  }
  for (const [key, values] of Object.entries({
    authentication: ['NotRequired', 'Required', 'NoEncap'],
    encryption: ['NotRequired', 'Required', 'Dynamic'],
    interfaceType: ['Any', 'Wired', 'Wireless', 'RemoteAccess'],
  }))
    if (s[key] !== undefined && !values.includes(s[key]))
      throw Error('Choose a valid ' + key + '.');
  if ((s.authentication === undefined) !== (s.encryption === undefined))
    throw Error('Choose both authentication and encryption settings.');
  if (
    (s.authentication && s.authentication !== 'NotRequired' && s.action !== 'Allow') ||
    (s.encryption && s.encryption !== 'NotRequired' && s.authentication !== 'Required')
  )
    throw Error('Secure connections require Allow. Encryption requires IPsec authentication.');
  if (
    s.service !== undefined &&
    (typeof s.service !== 'string' || !/^[\w. -]{1,256}$/.test(s.service))
  )
    throw Error('Enter a service short name or Any.');
  if (
    s.description !== undefined &&
    (typeof s.description !== 'string' ||
      s.description.length > 1000 ||
      /[\x00-\x08\x0b-\x1f]/.test(s.description))
  )
    throw Error('Enter a description of up to 1,000 characters.');
  if (s.icmp !== undefined) {
    if (typeof s.icmp !== 'string' || !s.icmp || s.icmp.length > 200)
      throw Error('Enter ICMP types or Any.');
    if (s.icmp !== 'Any') {
      if (!['ICMPv4', 'ICMPv6', '1', '58'].includes(s.protocol))
        throw Error('ICMP types require ICMPv4 or ICMPv6.');
      for (const value of s.icmp.split(',')) {
        if (!/^\d{1,3}(:\d{1,3})?$/.test(value) || value.split(':').some((n) => +n > 255))
          throw Error('Use ICMP types or type:code pairs from 0 to 255.');
      }
    }
  }
  return Object.fromEntries(
    [
      'displayName',
      'direction',
      'action',
      'protocol',
      'profiles',
      'localPort',
      'remotePort',
      'program',
      'remoteAddress',
      'localAddress',
      'authentication',
      'encryption',
      'icmp',
      'service',
      'interfaceType',
      'description',
    ]
      .filter((k) => s[k] !== undefined)
      .map((k) => [k, s[k]]),
  );
}
async function readFirewall(action, data) {
  const source = await fs.readFile(path.join(__dirname, 'firewall-commands.ps1'), 'utf8');
  const json = Buffer.from(JSON.stringify(data || {})).toString('base64');
  return readSource(
    `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${source}\nInvoke-OmniaFirewall '${action}' ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json}')) | ConvertFrom-Json)`,
  );
}
/** Reviews Windows rule changes and journals reversible mutations through the admin service. */
function createFirewall({
  admin,
  journalPath,
  readFn = readFirewall,
  platform = process.platform,
} = {}) {
  let snapshot = null,
    busy = false,
    mutating = false,
    history = [],
    loaded = false;
  const plans = new Map();
  const status = () => ({
    supported: platform === 'win32',
    snapshot,
    busy,
    history: history.map(({ id, operation, name, time, undone, pending, error }) => ({
      id,
      operation,
      name,
      time,
      undone,
      pending,
      error,
    })),
  });
  const read = async (action, data) =>
    admin.status().enabled
      ? JSON.parse((await admin.run(action, data || {})).message)
      : readFn(action, data);
  async function load() {
    if (loaded) return;
    try {
      history = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw Error('Firewall history is unreadable. Preserve it before retrying.');
    }
    loaded = true;
  }
  async function save() {
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.writeFile(journalPath + '.tmp', JSON.stringify(history, null, 2));
    await fs.rename(journalPath + '.tmp', journalPath);
  }
  async function exclusive(fn) {
    if (platform !== 'win32') throw Error('Firewall Manager currently supports Windows.');
    if (busy) throw Error('A firewall operation is already running.');
    busy = true;
    try {
      await load();
      return await fn();
    } finally {
      busy = false;
    }
  }
  async function refresh() {
    return exclusive(async () => {
      snapshot = await read('firewall-list');
      snapshot.checkedAt = new Date().toISOString();
      return status();
    });
  }
  async function detail(name) {
    return exclusive(async () => {
      if (!snapshot?.rules.some((r) => r.name === name)) throw Error('Refresh and select a rule.');
      return read('firewall-detail', { name });
    });
  }
  async function prepare(operation, data = {}) {
    return exclusive(async () => {
      if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
      let payload, summary;
      if (operation === 'create') {
        const spec = validateSpec(data.spec);
        payload = { operation, name: 'OMNIA-' + crypto.randomUUID(), spec };
        summary = { after: spec };
      } else if (operation === 'undo') {
        const h = history.find((h) => h.id === data.id);
        if (!h || h.undone || h.pending || !h.result)
          throw Error('This operation has no completed undo record.');
        payload = {
          operation: h.result.operation === 'create' ? 'undo-create' : 'undo',
          name: h.result.name,
          expected: h.result.after,
          backup: h.result.backup,
          backupHash: h.result.backupHash,
          wasEnabled: h.result.wasEnabled,
        };
        summary = { undo: h.operation, name: h.name };
      } else if (['enable', 'disable', 'delete', 'edit'].includes(operation)) {
        const current = await read('firewall-detail', { name: data.name });
        if (!current.local) throw Error('Managed and non-local rules are read-only.');
        payload = { operation, name: data.name, expected: current.hash };
        if (operation === 'edit') payload.spec = validateSpec(data.spec);
        summary = { before: current.values, after: payload.spec || operation };
      } else throw Error('Unsupported firewall action.');
      const token = crypto.randomUUID();
      plans.clear();
      plans.set(token, { payload, operation, undoId: data.id, expires: Date.now() + 120000 });
      return { token, operation, summary };
    });
  }
  async function execute(token) {
    return exclusive(async () => {
      const plan = plans.get(token);
      plans.delete(token);
      if (!plan || plan.expires < Date.now())
        throw Error('Review expired. Prepare the action again.');
      if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
      const entry = {
        id: crypto.randomUUID(),
        operation: plan.operation,
        name: plan.payload.name,
        time: new Date().toISOString(),
        pending: true,
        payload: plan.payload,
      };
      history.unshift(entry);
      await save();
      mutating = true;
      try {
        entry.result = JSON.parse((await admin.run('firewall-change', plan.payload)).message);
        entry.pending = false;
        if (plan.undoId) {
          const old = history.find((h) => h.id === plan.undoId);
          if (old) old.undone = true;
          entry.undone = true;
        }
        await save();
        snapshot = null;
        return status();
      } catch (e) {
        entry.error = e.message;
        entry.pending = false;
        await save();
        throw e;
      } finally {
        mutating = false;
      }
    });
  }
  return {
    status,
    refresh,
    detail,
    prepare,
    execute,
    isBusy: () => busy,
    isMutating: () => mutating,
  };
}
module.exports = { createFirewall, validateSpec, readFirewall };
