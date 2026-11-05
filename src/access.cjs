const crypto = require('node:crypto');
const registry = require('../assets/tools.json');
const media = new Set(['media', 'mp3', 'mp4', 'gif']);
const adminActions = {
  network: [
    'flush-dns',
    'register-dns',
    'renew-dhcp',
    'restart-adapter',
    'dns-cloudflare',
    'dns-google',
    'dns-auto',
  ],
  drives: ['drive-label', 'drive-letter', 'drive-format', 'drive-reset'],
  drivers: ['driver-list', 'driver-backup', 'driver-remove'],
  firewall: ['firewall-list', 'firewall-detail', 'firewall-change'],
  repair: ['repair-run'],
};
const readActions = new Set(['driver-list', 'firewall-list', 'firewall-detail']);
function denied() {
  throw Object.assign(Error('This tool cannot access that operation.'), {
    code: 'OMNIA_ACCESS_DENIED',
  });
}

/** Binds both launch credentials and HTTP sessions to a server-owned tool identity. */
function createSessions() {
  const scopes = new Map(
    ['home', 'media', ...registry.map((t) => t.id)].map((scope) => [
      scope,
      {
        scope,
        launch: crypto.randomBytes(32).toString('hex'),
        token: crypto.randomBytes(32).toString('hex'),
      },
    ]),
  );
  return {
    launch(scope) {
      const session = scopes.get(scope);
      if (!session) denied();
      return session.launch;
    },
    cookie(scope) {
      const session = scopes.get(scope);
      if (!session) denied();
      return 'omnia=' + session.token;
    },
    redeem(key) {
      return [...scopes.values()].find((s) => s.launch === key)?.scope;
    },
    identify(cookie = '') {
      const values = cookie
        .split(';')
        .map((v) => v.trim())
        .filter((v) => v.startsWith('omnia='));
      if (values.length !== 1) return null;
      return [...scopes.values()].find((s) => values[0] === 'omnia=' + s.token)?.scope || null;
    },
  };
}
function httpAccess(scope, route, method, data) {
  if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data))) denied();
  if (route.startsWith('/api/network/')) {
    if (!['network', 'speed'].includes(scope)) denied();
    if (
      scope === 'speed' &&
      ![
        '/api/network/quick',
        '/api/network/info',
        '/api/network/job',
        '/api/network/speed-servers',
        '/api/network/cancel',
        '/api/network/run',
      ].includes(route)
    )
      denied();
    if (scope === 'speed' && data && route === '/api/network/run' && data.kind !== 'speed')
      denied();
  } else if (route.startsWith('/api/files/preview/')) {
    if (!['images', 'metadata', 'inspector'].includes(scope)) denied();
  } else if (route.startsWith('/api/')) {
    if (!media.has(scope)) denied();
    if (data?.tool && scope !== 'media' && data.tool !== scope) denied();
  }
}
function brokerAccess(tool, action) {
  if (!adminActions[tool]?.includes(action) && !(tool === 'duplicates' && action === 'trash'))
    denied();
}
function ipcAccess(tool, channel, action, data = {}, ownerOf = () => undefined) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) denied();
  if (channel === 'settings' && (tool === 'home' || registry.some((t) => t.id === tool))) {
    if (
      ['get', 'update'].includes(action) ||
      (tool === 'home' && ['open', 'cover', 'uncover'].includes(action))
    )
      return;
    denied();
  }
  if (tool === 'home') {
    if (
      [
        'validation',
        'history',
        'open',
        'tool-info',
        'tool-view',
        'admin',
        'updates',
        'expand',
        'expand-frame',
      ].includes(channel)
    )
      return;
    if (channel === 'tool-health' && ['status', 'reset', 'fault'].includes(action)) return;
    if (channel === 'drives' && action === 'status') return;
    denied();
  }
  if (!registry.some((t) => t.id === tool)) denied();
  if (channel === 'history' && ['back', 'forward'].includes(action)) return;
  if (channel === 'tool-info' || channel === 'copy') return;
  if (channel === 'open' && action === 'home') return;
  if (
    channel === 'tool-health' &&
    (action === 'status' || (action === 'fault' && data.id === tool))
  )
    return;
  if (channel === 'admin' && (action === 'status' || (action === 'enable' && adminActions[tool])))
    return;
  if (channel === 'network-settings' && tool === 'network') return;
  const expected = ['images', 'metadata', 'inspector'].includes(tool)
    ? 'files'
    : ['rename', 'duplicates', 'search'].includes(tool)
      ? 'file-tools'
      : tool;
  if (channel !== expected) denied();
  if (data.tool && data.tool !== tool) denied();
  if (channel === 'file-tools') {
    const actions = [
      'status',
      'query',
      'cancel',
      'reveal',
      'clear',
      'drop',
      'choose',
      'start',
      'roots',
      'folders',
      'select',
      'remove',
    ];
    if (tool === 'rename') actions.push('history', 'rename', 'undo', 'execute');
    if (tool === 'duplicates') actions.push('trash', 'execute');
    if (!actions.includes(action) || data.tool !== tool) denied();
    if (action === 'execute' && ownerOf(data.token) !== tool) denied();
  }
  if (channel === 'files') {
    if (['status', 'cancel', 'save'].includes(action) && ownerOf(data.id) !== tool) denied();
    if (
      action === 'save-batch' &&
      (!Array.isArray(data.ids) || !data.ids.length || data.ids.some((id) => ownerOf(id) !== tool))
    )
      denied();
    if (['choose', 'drop', 'clear', 'start', 'reveal'].includes(action) && data.tool !== tool)
      denied();
  }
}
module.exports = { createSessions, httpAccess, brokerAccess, ipcAccess, readActions, denied };
