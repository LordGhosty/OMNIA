const path = require('node:path');
const port = process.parentPort;
const send = (message) => (port ? port.postMessage(message) : process.send?.(message));
const listen = (handler) =>
  port ? port.on('message', (event) => handler(event.data)) : process.on('message', handler);
let service,
  tool,
  adminState = {},
  sequence = 0,
  closing = false;
const pending = new Map();
const busy = () => !!service?.isBusy?.() || !!service?.isMutating?.();
function broker(action, data, onProgress) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    send({ type: 'broker', id, action, data });
  });
}
const admin = {
  status: () => adminState,
  run: (action, data, progress) => broker(action, data, progress),
};
const event = (name, data) => send({ type: 'event', name, data });
async function create(kind, options) {
  const root = options.userData;
  switch (kind) {
    case 'ssh':
      return require('./ssh-keys.cjs').createSSHKeys({ helper: options.helper });
    case 'workbench':
      return require('./workbench.cjs').createWorkbench();
    case 'files':
      return require('./file-tools.cjs').createFileTools({
        journalDir: path.join(root, 'rename-history'),
        places: options.places,
        trash: (file) => broker('trash', { file }),
      });
    case 'diskspace': {
      const disk = require('./diskspace.cjs').createDiskSpace();
      return { ...disk, clear: disk.close };
    }
    case 'firewall':
      return require('./firewall.cjs').createFirewall({
        admin,
        journalPath: path.join(root, 'firewall-history.json'),
      });
    case 'repair': {
      const read = () => require('./system-read.cjs').readScript('storage-inventory.ps1');
      return {
        ...require('./repair.cjs').createRepair({
          admin,
          inventoryFn: read,
          reportPath: path.join(root, 'last-repair.json'),
        }),
        volumes: read,
      };
    }
    case 'drivers':
      return require('./drivers.cjs').createDrivers({
        admin,
        backupRoot: path.join(root, 'driver-backups'),
      });
    case 'drives':
      return require('./drives.cjs').createDrives({
        admin,
        settingsPath: path.join(root, 'automatic-flash.json'),
        onChange: (state) => event('drives', state),
        onInsert: (disk, action) => event('insert', { disk, action }),
      });
    case 'network':
      return {
        ...require('./network.cjs').createNetworkService({
          actionFn: (action, adapter) =>
            admin.run(action, { index: adapter?.index, guid: adapter?.guid }),
        }),
        subnet: require('./network.cjs').subnet,
        serverList: require('./speed.cjs').serverList,
      };
    case 'media': {
      const server = await require('./server.cjs').startServer();
      return {
        ...server,
        connection: () => ({
          origin: server.origin,
          cookie: server.sessionCookie(tool || 'media'),
        }),
      };
    }
    default:
      throw Error('Unknown tool service.');
  }
}
const allowed = {
  ssh: [
    'status',
    'refresh',
    'selectFolder',
    'selectFile',
    'generate',
    'inspect',
    'change',
    'exportPublic',
    'clear',
    'cancel',
  ],
  workbench: [
    'select',
    'clear',
    'start',
    'cancel',
    'save',
    'saveBatch',
    'asset',
    'source',
    'status',
  ],
  files: [
    'roots',
    'folders',
    'remove',
    'status',
    'query',
    'cancel',
    'history',
    'location',
    'clear',
    'select',
    'start',
    'prepareRename',
    'prepareUndo',
    'prepareTrash',
    'execute',
  ],
  diskspace: ['status', 'refresh', 'cancel', 'query', 'startVolume', 'start', 'clear'],
  firewall: ['status', 'refresh', 'detail', 'prepare', 'execute'],
  repair: ['status', 'prepare', 'execute', 'volumes'],
  drivers: ['status', 'refresh', 'prepare', 'execute', 'location'],
  drives: ['view', 'refresh', 'prepare', 'execute', 'configure', 'insertionTask'],
  network: [
    'quick',
    'info',
    'view',
    'cancel',
    'subnet',
    'start',
    'prepare',
    'execute',
    'serverList',
  ],
  media: ['connection'],
};
let kind;
listen(async (packet) => {
  try {
    if (packet.type === 'init') {
      kind = packet.kind;
      tool = packet.options.tool;
      adminState = packet.options.adminState || {};
      service = await create(kind, packet.options);
      send({ type: 'ready' });
    } else if (packet.type === 'admin') adminState = packet.state;
    else if (packet.type === 'broker-progress') pending.get(packet.id)?.onProgress?.(packet.text);
    else if (packet.type === 'broker-reply') {
      const p = pending.get(packet.id);
      pending.delete(packet.id);
      if (p) packet.error ? p.reject(Error(packet.error.message)) : p.resolve(packet.value);
    } else if (packet.type === 'shutdown') {
      closing = true;
      await service?.close?.();
      process.exit(0);
    } else if (packet.type === 'call') {
      if (!allowed[kind]?.includes(packet.method)) throw Error('Unsupported tool operation.');
      try {
        if (
          tool === 'speed' &&
          (['prepare', 'execute', 'subnet'].includes(packet.method) ||
            (packet.method === 'start' && packet.args[0] !== 'speed'))
        )
          require('./access.cjs').denied();
        if (
          tool &&
          ['workbench', 'files'].includes(kind) &&
          [
            'select',
            'clear',
            'start',
            'source',
            ...(kind === 'files' ? ['status', 'query', 'cancel', 'location'] : []),
          ].includes(packet.method) &&
          packet.args[0] !== tool
        )
          require('./access.cjs').denied();
        if (
          tool &&
          kind === 'files' &&
          ((['prepareRename', 'prepareUndo', 'history'].includes(packet.method) &&
            tool !== 'rename') ||
            (packet.method === 'prepareTrash' && tool !== 'duplicates'))
        )
          require('./access.cjs').denied();
        const value = await service[packet.method](...packet.args);
        send({ type: 'reply', id: packet.id, value, busy: busy() });
      } catch (error) {
        const fatal =
          error instanceof TypeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError;
        send({
          type: 'reply',
          id: packet.id,
          error: { message: error.message, code: fatal ? 'OMNIA_TOOL_FAILED' : error.code },
          busy: busy(),
        });
        if (fatal) {
          send({ type: 'fault', reason: 'The tool stopped unexpectedly.' });
          process.exit(1);
        }
      }
    }
  } catch {
    send({ type: 'fault', reason: 'The tool could not start.' });
    process.exit(1);
  }
});
setInterval(() => {
  if (!closing) send({ type: 'beat', busy: busy() });
}, 1000).unref();
process.on('uncaughtException', () => {
  send({ type: 'fault', reason: 'The tool process stopped unexpectedly.' });
  process.exit(1);
});
process.on('unhandledRejection', () => {
  send({ type: 'fault', reason: 'The tool process stopped unexpectedly.' });
  process.exit(1);
});
