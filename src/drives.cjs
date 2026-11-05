const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const flash = require('./flash.cjs');
const inventoryScript = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$items=@(Get-Disk | Where-Object {$_.BusType -eq 'USB'} | ForEach-Object {$d=$_;$parts=@(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | ForEach-Object {$p=$_;$v=$p | Get-Volume -ErrorAction SilentlyContinue;[pscustomobject]@{number=$p.PartitionNumber;offset=[long]$p.Offset;size=[long]$p.Size;letter=[string]$p.DriveLetter;label=[string]$v.FileSystemLabel;fileSystem=[string]$v.FileSystem;free=[long]$v.SizeRemaining;protected=($p.IsBoot -or $p.IsSystem)}});[pscustomobject]@{number=$d.Number;name=[string]$d.FriendlyName;uniqueId=[string]$d.UniqueId;serial=[string]$d.SerialNumber;size=[long]$d.Size;style=[string]$d.PartitionStyle;protected=($d.IsBoot -or $d.IsSystem -or $d.IsOffline -or $d.IsReadOnly);partitions=$parts}});ConvertTo-Json -InputObject $items -Compress -Depth 5`;
const identity = (d) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([d.uniqueId, d.serial, d.size]))
    .digest('hex');
function inventory() {
  if (process.platform !== 'win32') return Promise.resolve([]);
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
        Buffer.from(inventoryScript, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(Error('Could not read USB drives. ' + error.message));
        try {
          resolve(JSON.parse(stdout || '[]').map((d) => ({ ...d, id: identity(d) })));
        } catch {
          reject(Error('Windows returned unreadable drive details.'));
        }
      },
    ),
  );
}
function validateAction(action, input, disks) {
  if (
    ![
      'drive-label',
      'drive-letter',
      'drive-format',
      'drive-reset',
      'flash-create',
      'flash-authorize',
    ].includes(action)
  )
    throw Error('Unsupported drive action.');
  const d = disks.find((d) => d.id === input.id);
  if (!d || !d.uniqueId || d.protected || d.partitions.some((p) => p.protected))
    throw Error('Select a writable, non-system USB disk.');
  const p = d.partitions.find((p) => p.number === Number(input.partition));
  if (action !== 'drive-reset' && !p) throw Error('Select a data volume.');
  const data = {
    number: d.number,
    uniqueId: d.uniqueId,
    serial: d.serial,
    size: d.size,
    partition: p?.number,
    offset: p?.offset,
    partitionSize: p?.size,
  };
  data.label = String(input.label ?? 'OMNIA');
  if (data.label.length > 32 || /[\\/:*?"<>|\x00-\x1f]/.test(data.label))
    throw Error('Use a volume label of at most 32 characters without path characters.');
  data.fileSystem = input.fileSystem || 'exFAT';
  if (
    ['drive-format', 'drive-reset'].includes(action) &&
    !['exFAT', 'NTFS', ...(action === 'drive-format' ? ['FAT32'] : [])].includes(data.fileSystem)
  )
    throw Error('Choose a supported file system.');
  if (data.fileSystem === 'FAT32' && p?.size > 32 * 1024 ** 3)
    throw Error('Choose exFAT or NTFS for volumes larger than 32 GiB.');
  if (action === 'drive-letter') {
    data.letter = String(input.letter || '').toUpperCase();
    if (!/^[D-Z]$/.test(data.letter)) throw Error('Choose a letter from D to Z.');
  }
  const destructive = ['drive-format', 'drive-reset'].includes(action);
  return {
    disk: d,
    partition: p,
    action,
    data,
    destructive,
    phrase: destructive ? 'ERASE ' + d.number : '',
    title: {
      'drive-label': 'Rename volume',
      'drive-letter': 'Assign drive letter',
      'drive-format': 'Quick-format volume',
      'drive-reset': 'Reset entire disk',
    }[action],
  };
}
/** Tracks removable disks and binds confirmed actions to their current device identity. */
function createDrives({
  admin,
  settingsPath,
  onChange = () => {},
  onInsert = () => {},
  inventoryFn = inventory,
  resolveDirectory,
} = {}) {
  let disks = [],
    error = '',
    refreshing,
    operation = null,
    known,
    settings = {};
  const plans = new Map();
  const loaded = fs
    .readFile(settingsPath, 'utf8')
    .then((text) => {
      settings = Object.fromEntries(
        Object.entries(JSON.parse(text)).filter(
          ([, action]) => action === 'show-tool' || action?.kind === 'custom',
        ),
      );
    })
    .catch(() => {});
  const view = () => ({
    supported: process.platform === 'win32',
    disks,
    error,
    busy: !!operation,
    actions: Object.fromEntries(
      Object.entries(settings).map(([id, action]) => [
        id,
        typeof action === 'object' ? 'custom' : action,
      ]),
    ),
  });
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        await loaded;
        const next = await inventoryFn();
        disks = next;
        error = '';
        if (known)
          for (const d of next) if (!known.has(d.id) && settings[d.id]) onInsert(d, settings[d.id]);
        known = new Set(next.map((d) => d.id));
      } catch (e) {
        error = e.message;
      }
      onChange(view());
      return view();
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }
  async function prepare(action, input) {
    await refresh();
    if (error) throw Error(error);
    const plan = validateAction(action, input, disks);
    if (action === 'flash-create') {
      plan.task = flash.taskFor(input.task);
      plan.title = 'Create Automatic Flash task';
    }
    if (action === 'flash-authorize') {
      const folder = await directory(plan);
      plan.task = flash.taskFor(
        await fs.readFile(path.join(folder, 'AutomaticFlash.json'), 'utf8'),
      );
      if (plan.task.platform !== process.platform)
        throw Error('This task is for a different operating system.');
      plan.title = 'Authorize Automatic Flash task';
    }
    const token = crypto.randomUUID();
    plans.set(token, { ...plan, expires: Date.now() + (plan.task ? 300000 : 60000) });
    for (const [key, value] of plans) if (value.expires < Date.now()) plans.delete(key);
    return {
      token,
      title: plan.title,
      destructive: plan.destructive,
      phrase: plan.phrase,
      disk: plan.disk,
      partition: plan.partition,
      task: plan.task,
    };
  }
  async function directory(plan) {
    if (resolveDirectory) return resolveDirectory(plan);
    const letter = plan.partition?.letter;
    if (!/^[A-Z]$/.test(letter)) throw Error('Assign a drive letter first.');
    const root = letter + ':\\',
      folder = path.join(root, 'OMNIA');
    await fs.mkdir(folder, { recursive: true });
    const resolved = await fs.realpath(folder);
    if (
      resolved.toLowerCase() !== folder.toLowerCase() ||
      (await fs.lstat(folder)).isSymbolicLink()
    )
      throw Error('The OMNIA folder must be a normal folder on the selected USB drive.');
    return folder;
  }
  async function execute(token, phrase) {
    if (operation) throw Error('A drive operation is already running.');
    const plan = plans.get(token);
    plans.delete(token);
    if (!plan || plan.expires < Date.now())
      throw Error('Confirmation expired. Choose the action again.');
    if (plan.destructive && phrase !== plan.phrase) throw Error('The erase phrase does not match.');
    operation = (async () => {
      await refresh();
      if (error) throw Error(error);
      const fresh = validateAction(
        plan.action,
        { id: plan.disk.id, partition: plan.partition?.number, ...plan.data },
        disks,
      );
      if (
        fresh.disk.number !== plan.disk.number ||
        fresh.partition?.offset !== plan.partition?.offset ||
        fresh.partition?.size !== plan.partition?.size
      )
        throw Error('The selected drive changed. Confirm it again.');
      if (plan.action === 'flash-create') {
        const folder = await directory(fresh);
        await fs.writeFile(
          path.join(folder, 'AutomaticFlash.json'),
          JSON.stringify(plan.task, null, 2),
          { flag: 'wx' },
        );
        return {
          ok: true,
          message:
            'AutomaticFlash.json created. Review and authorize it separately on each receiving computer. Existing tasks are never overwritten.',
        };
      }
      if (plan.action === 'flash-authorize') {
        const folder = await directory(fresh),
          task = flash.taskFor(await fs.readFile(path.join(folder, 'AutomaticFlash.json'), 'utf8'));
        if (flash.fingerprint(task) !== flash.fingerprint(plan.task))
          throw Error('The task changed during review. Authorize it again.');
        settings[plan.disk.id] = {
          kind: 'custom',
          task,
          hash: flash.fingerprint(task),
          partition: plan.partition.number,
        };
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(settings));
        return {
          ok: true,
          message:
            'Task authorized on this computer. It will run on the next insertion while OMNIA is open, with normal user permissions.',
        };
      }
      return admin.run(plan.action, { ...plan.data, erase: phrase });
    })();
    onChange(view());
    try {
      return await operation;
    } finally {
      operation = null;
      await refresh();
    }
  }
  async function configure(id, action) {
    if (!['', 'show-tool'].includes(action)) throw Error('Choose a supported insertion action.');
    await loaded;
    const disk = disks.find((d) => d.id === id);
    if (!disk || !disk.uniqueId || disk.protected) throw Error('Select a supported USB drive.');
    if (action) settings[id] = action;
    else delete settings[id];
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings));
    onChange(view());
    return view();
  }
  async function insertionTask(d, approved) {
    if (operation) return;
    operation = (async () => {
      const plan = validateAction(
          'flash-authorize',
          { id: d.id, partition: approved.partition },
          disks,
        ),
        folder = await directory(plan);
      const current = flash.taskFor(
        await fs.readFile(path.join(folder, 'AutomaticFlash.json'), 'utf8'),
      );
      if (
        flash.fingerprint(current) !== approved.hash ||
        flash.fingerprint(approved.task) !== approved.hash
      )
        throw Error('Automatic Flash task changed. Review and authorize it again.');
      return flash.runTask(approved.task, { directory: folder });
    })();
    onChange(view());
    try {
      return await operation;
    } finally {
      operation = null;
      onChange(view());
    }
  }
  return {
    view,
    refresh,
    prepare,
    execute,
    configure,
    insertionTask,
    isBusy: () => !!operation,
    close: async () => {
      await operation?.catch(() => {});
    },
  };
}
module.exports = { createDrives, inventory, inventoryScript, validateAction, identity };
