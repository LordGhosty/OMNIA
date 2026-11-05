const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
let cancelled = false,
  last = 0;
parentPort.on('message', (m) => {
  if (m === 'cancel') cancelled = true;
});
const state = {
  phase: 'scanning',
  visited: 0,
  matched: 0,
  skipped: 0,
  hashed: 0,
  issues: [],
  partial: false,
};
function report(force = false) {
  if (force || Date.now() - last > 250) {
    last = Date.now();
    parentPort.postMessage({ type: 'status', state });
  }
}
function issue(file, error) {
  state.skipped++;
  if (state.issues.length < 30)
    state.issues.push({ path: file, reason: error.message || String(error) });
}
function identity(s) {
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtime: String(s.mtimeNs) };
}
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
async function hash(file) {
  const handle = await fs.open(file.path, 'r');
  try {
    if (!same(file.identity, identity(await handle.stat({ bigint: true }))))
      throw Error('File changed.');
    const hash = crypto.createHash('sha256'),
      buffer = Buffer.allocUnsafe(262144);
    let position = 0;
    while (!cancelled) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (cancelled) throw Error('Cancelled.');
    if (!same(file.identity, identity(await handle.stat({ bigint: true }))))
      throw Error('File changed.');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
async function equal(a, b) {
  const handles = [];
  try {
    handles.push(await fs.open(a.path, 'r'));
    handles.push(await fs.open(b.path, 'r'));
    const buffers = [Buffer.allocUnsafe(262144), Buffer.allocUnsafe(262144)];
    let pos = 0;
    while (!cancelled) {
      const reads = await Promise.all(
        handles.map((h, i) => h.read(buffers[i], 0, buffers[i].length, pos)),
      );
      if (reads[0].bytesRead !== reads[1].bytesRead) return false;
      if (!reads[0].bytesRead) return true;
      if (
        !buffers[0]
          .subarray(0, reads[0].bytesRead)
          .equals(buffers[1].subarray(0, reads[1].bytesRead))
      )
        return false;
      pos += reads[0].bytesRead;
    }
    return false;
  } finally {
    await Promise.all(handles.map((h) => h.close()));
  }
}
async function run() {
  const { roots, tool, options = {}, limit = tool === 'rename' ? 10000 : 100000 } = workerData;
  const files = [],
    seenDirs = new Set(),
    seenFiles = new Set();
  const { nameMatcher } = require('./file-match.cjs');
  const match = nameMatcher(options.name, options.match, options.caseSensitive);
  const excluded = options.exclude
    ? nameMatcher(options.exclude, 'auto', options.caseSensitive)
    : () => false;
  const extensions = String(options.extensions || '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^\*?\./, ''))
    .filter(Boolean);
  const pending = roots.map((p) => ({ path: p, depth: 0 }));
  let sent = 0,
    sentAt = 0;
  const pathKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  function publish(force = false) {
    report(force);
    if (tool === 'search' && files.length > sent && (force || Date.now() - sentAt > 250)) {
      parentPort.postMessage({ type: 'results', state, files: files.slice(sent) });
      sent = files.length;
      sentAt = Date.now();
    }
  }
  async function visit(item, entry, parent) {
    if (cancelled || state.partial) return;
    state.visited++;
    state.current = parent || path.dirname(item.path);
    const name = path.basename(item.path);
    if (excluded(name)) return;
    try {
      if (entry?.isSymbolicLink()) {
        issue(item.path, 'Link skipped.');
        return;
      }
      // Skip metadata reads for filenames that cannot match the query.
      if (
        entry?.isFile() &&
        (!match(name) ||
          (extensions.length && !extensions.includes(path.extname(name).slice(1).toLowerCase())) ||
          (tool === 'search' && options.kind === 'folders'))
      )
        return;
      const stat = await fs.lstat(item.path, { bigint: true });
      if (stat.isSymbolicLink()) {
        issue(item.path, 'Link skipped.');
        return;
      }
      if (stat.isDirectory()) {
        if (item.depth === 0 || options.recursive) {
          if (seenDirs.has(pathKey(item.path))) return;
          seenDirs.add(pathKey(item.path));
          pending.push({ ...item, enumerate: true });
        }
        if (
          tool !== 'search' ||
          options.kind === 'files' ||
          extensions.length ||
          !item.depth ||
          !match(name)
        )
          return;
      } else if (!stat.isFile()) return;
      if (!stat.isDirectory() && tool !== 'search' && stat.nlink > 1n) {
        issue(item.path, 'Hard-linked file skipped.');
        return;
      }
      const folder = stat.isDirectory(),
        size = folder ? 0 : Number(stat.size),
        modified = Number(stat.mtimeMs);
      if (
        !match(name) ||
        (!folder &&
          extensions.length &&
          !extensions.includes(path.extname(name).slice(1).toLowerCase())) ||
        (!folder && tool === 'search' && options.kind === 'folders') ||
        size < (options.minBytes || 0) ||
        (options.maxBytes != null && size > options.maxBytes) ||
        (options.after != null && modified < options.after) ||
        (options.before != null && modified > options.before)
      )
        return;
      if (seenFiles.has(pathKey(item.path))) return;
      if (files.length >= limit) {
        state.partial = true;
        state.limit = limit;
        return;
      }
      seenFiles.add(pathKey(item.path));
      files.push({
        id: crypto.randomUUID(),
        path: item.path,
        name,
        kind: folder ? 'folder' : 'file',
        size,
        modified,
        extension: folder ? '' : path.extname(name).slice(1).toLowerCase(),
        identity: identity(stat),
        parent: parent || (await fs.realpath(path.dirname(item.path))),
      });
      state.matched = files.length;
    } catch (error) {
      issue(item.path, error);
    }
  }
  while (pending.length && !cancelled && !state.partial) {
    const item = pending.pop();
    if (!item.enumerate) {
      await visit(item);
      publish();
      continue;
    }
    try {
      const parent = await fs.realpath(item.path);
      const dir = await fs.opendir(item.path);
      let batch = [];
      for await (const entry of dir) {
        if (cancelled || state.partial) break;
        batch.push(
          visit({ path: path.join(item.path, entry.name), depth: item.depth + 1 }, entry, parent),
        );
        if (batch.length === 16) {
          await Promise.all(batch);
          batch = [];
          publish();
        }
      }
      await Promise.all(batch);
    } catch (error) {
      issue(item.path, error);
    }
    publish();
  }
  publish(true);
  files.sort((a, b) => a.path.localeCompare(b.path));
  let groups = [];
  if (tool === 'duplicates' && !cancelled) {
    state.phase = 'comparing';
    report(true);
    const sizes = new Map(),
      hashes = new Map();
    for (const f of files) {
      const list = sizes.get(f.size) || [];
      list.push(f);
      sizes.set(f.size, list);
    }
    for (const list of sizes.values())
      if (list.length > 1)
        for (const f of list) {
          if (cancelled) break;
          try {
            f.hash = await hash(f);
            const key = f.size + ':' + f.hash;
            const matches = hashes.get(key) || [];
            matches.push(f);
            hashes.set(key, matches);
            state.hashed++;
          } catch (e) {
            issue(f.path, e);
          }
          report();
        }
    for (const list of hashes.values()) {
      if (cancelled) break;
      if (list.length < 2) continue;
      const verified = [];
      for (const f of list) {
        let group;
        for (const g of verified) {
          try {
            if (await equal(g[0], f)) {
              group = g;
              break;
            }
          } catch (e) {
            issue(f.path, e);
          }
        }
        if (group) group.push(f);
        else verified.push([f]);
      }
      for (const g of verified)
        if (g.length > 1)
          groups.push({ id: crypto.randomUUID(), size: g[0].size, files: g.map((f) => f.id) });
    }
  }
  const orders = {
    name: files.map((f) => f.id),
    size: [...files].sort((a, b) => b.size - a.size).map((f) => f.id),
    date: [...files].sort((a, b) => b.modified - a.modified).map((f) => f.id),
  };
  state.phase = cancelled ? 'cancelled' : state.partial ? 'partial' : 'complete';
  parentPort.postMessage({ type: 'done', state, files, groups, orders });
  parentPort.close();
}
run().catch((e) => {
  state.phase = 'error';
  issue('', e);
  parentPort.postMessage({ type: 'done', state, files: [], groups: [] });
  parentPort.close();
});
