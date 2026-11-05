const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function pathError(error) {
  if (['EACCES', 'EPERM'].includes(error.code))
    return Error('This folder cannot be read with your current permissions.');
  if (['ENOENT', 'ENOTDIR', 'ENODEV'].includes(error.code))
    return Error(
      'This location is no longer available. Reconnect the drive or choose another folder.',
    );
  return error;
}

/** Lists discovered locations and paged child folders without scanning their contents. */
function createLocations({
  places = [{ name: 'Home', path: os.homedir() }],
  platform = process.platform,
  drives,
} = {}) {
  const cache = new Map();
  async function roots(part = 'all') {
    if (!['all', 'folders', 'drives'].includes(part)) throw Error('Choose folders or drives.');
    const folders = (
      await Promise.all(
        (part === 'drives' ? [] : places).map(async (entry) => {
          try {
            return (await fs.stat(entry.path)).isDirectory() ? { ...entry, kind: 'folder' } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);
    let volumes = [],
      issue = '';
    if (part === 'folders') return { folders, drives: [], issue };
    try {
      if (drives) volumes = await drives();
      else if (platform === 'win32')
        volumes = await require('./system-read.cjs').readScript('file-locations.ps1');
      else {
        volumes = [{ name: 'File system', path: '/', kind: 'drive' }];
        for (const mount of platform === 'darwin'
          ? ['/Volumes']
          : ['/media', '/mnt', '/run/media']) {
          for (const entry of await fs.readdir(mount, { withFileTypes: true }).catch(() => []))
            if (entry.isDirectory())
              volumes.push({ name: entry.name, path: path.join(mount, entry.name), kind: 'drive' });
        }
      }
    } catch {
      issue = 'Drive discovery is unavailable. You can still browse to a folder or enter its path.';
    }
    return { folders, drives: Array.isArray(volumes) ? volumes : [volumes], issue };
  }
  async function children(folder, offset = 0) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0'))
      throw Error('Enter a full folder path.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Choose a valid folder page.');
    try {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Choose a regular folder. Folder links are not followed.');
      let item = cache.get(folder);
      if (!item || item.expires < Date.now() || offset === 0) {
        const rows = (await fs.readdir(folder, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map((entry) => ({
            name: entry.name,
            path: path.join(folder, entry.name),
            kind: 'folder',
          }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        item = { rows, expires: Date.now() + 30000 };
        if (cache.size >= 12) cache.delete(cache.keys().next().value);
        cache.set(folder, item);
      }
      return { rows: item.rows.slice(offset, offset + 100), total: item.rows.length };
    } catch (error) {
      throw pathError(error);
    }
  }
  return { roots, children };
}
module.exports = { createLocations, pathError };
