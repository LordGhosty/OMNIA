const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const blocked = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])
  blocked.addSubnet(ip, bits, 'ipv6');
function publicLookup(host, options, callback) {
  dns.lookup(host, { all: true, family: options.family || 0 }, (error, rows) => {
    if (error) return callback(error);
    const safe = rows.filter((r) => !blocked.check(r.address, r.family === 6 ? 'ipv6' : 'ipv4'));
    if (!safe.length)
      return callback(Error('Measurement servers must use public network addresses.'));
    if (options.all) callback(null, safe);
    else callback(null, safe[0].address, safe[0].family);
  });
}
function parseCatalog(rows) {
  if (!Array.isArray(rows)) throw Error('Invalid server catalogue.');
  const result = {};
  for (const row of rows.slice(0, 128)) {
    if (
      !Number.isSafeInteger(Number(row.id)) ||
      typeof row.name !== 'string' ||
      row.name.length > 160
    )
      continue;
    try {
      const base = new URL(row.server);
      if (
        base.protocol !== 'https:' ||
        base.username ||
        base.password ||
        (base.port && base.port !== '443') ||
        net.isIP(base.hostname) ||
        !base.hostname.includes('.')
      )
        continue;
      if (!base.pathname.endsWith('/')) base.pathname += '/';
      const urls = {};
      for (const [key, field] of [
        ['download', 'dlURL'],
        ['upload', 'ulURL'],
        ['ping', 'pingURL'],
      ]) {
        if (typeof row[field] !== 'string') throw Error();
        const url = new URL(row[field], base);
        if (url.origin !== base.origin || url.username || url.password) throw Error();
        urls[key] = url.href;
      }
      result['ls-' + row.id] = { name: 'LibreSpeed · ' + row.name, base: base.href, ...urls };
    } catch {}
  }
  return result;
}
let cached,
  updated = 0,
  loading;
async function catalog() {
  if (cached && Date.now() - updated < 86400000) return cached;
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const request = https.get(
      'https://librespeed.org/backend-servers/servers.php',
      { headers: { 'User-Agent': 'OMNIA/0.0.2' }, lookup: publicLookup },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(Error('Catalogue unavailable.'));
          return;
        }
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
          if (text.length > 256000) request.destroy(Error('Catalogue too large.'));
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const parsed = parseCatalog(JSON.parse(text));
            if (!Object.keys(parsed).length) throw Error('No supported servers.');
            cached = parsed;
            updated = Date.now();
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    const timer = setTimeout(() => request.destroy(Error('Catalogue request timed out.')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
  try {
    return await loading;
  } finally {
    loading = null;
  }
}
module.exports = { catalog, parseCatalog, publicLookup };
