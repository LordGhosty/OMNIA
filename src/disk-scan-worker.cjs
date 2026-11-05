const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises'),
  path = require('node:path');
const groups = {
  images: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'bmp', 'tif', 'tiff', 'svg'],
  video: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac'],
  documents: ['pdf', 'doc', 'docx', 'odt', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'],
  archives: ['zip', '7z', 'rar', 'gz', 'tar', 'iso', 'img'],
  applications: ['exe', 'dll', 'sys', 'msi', 'appx', 'msix'],
};
function category(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(groups).find((k) => groups[k].includes(ext)) || 'other';
}
const nodes = new Map(),
  seen = new Set();
let cancelled = false,
  phase = 'scanning',
  limitReason = '',
  last = 0,
  files = 0,
  folders = 0,
  skipped = 0,
  links = 0,
  hardlinks = 0,
  allocatedKnown = true,
  allocated = 0;
const errors = [];
const categories = Object.fromEntries([...Object.keys(groups), 'other'].map((k) => [k, 0]));
nodes.set(0, {
  id: 0,
  parent: null,
  name: path.basename(workerData.root) || workerData.root,
  path: workerData.root,
  kind: 'folder',
  bytes: 0,
  children: [],
  categories: { ...categories },
});
function report(force = false) {
  if (force || Date.now() - last > 300) {
    last = Date.now();
    parentPort.postMessage({
      type: 'status',
      status: {
        phase,
        root: workerData.root,
        bytes: nodes.get(0)?.bytes || 0,
        files,
        folders,
        skipped,
        links,
        hardlinks,
        allocated: allocatedKnown ? allocated : null,
        categories,
        issues: errors,
        limited: phase === 'limited',
        limitReason,
      },
    });
  }
}
function record(file, error) {
  skipped++;
  if (errors.length < 30) errors.push({ path: file, reason: error.code || error.message });
}
parentPort.on('message', (m) => {
  if (m.type === 'cancel') cancelled = true;
  if (m.type === 'query') {
    const n = nodes.get(m.id);
    if (!n)
      return parentPort.postMessage({
        type: 'reply',
        request: m.request,
        error: 'This scan entry is no longer available.',
      });
    if (m.location)
      return parentPort.postMessage({ type: 'reply', request: m.request, value: n.path });
    const rows = (n.children || [])
      .map((id) => nodes.get(id))
      .sort((a, b) =>
        m.sort === 'name'
          ? a.name.localeCompare(b.name)
          : b.bytes - a.bytes || a.name.localeCompare(b.name),
      );
    const breadcrumbs = [];
    let p = n;
    while (p) {
      breadcrumbs.unshift({ id: p.id, name: p.name });
      p = nodes.get(p.parent);
    }
    const view = (x) => ({
      id: x.id,
      name: x.name,
      path: x.path,
      bytes: x.bytes,
      logical: x.logical,
      kind: x.kind,
      category: x.category,
      linked: x.linked,
    });
    parentPort.postMessage({
      type: 'reply',
      request: m.request,
      value: {
        entry: view(n),
        breadcrumbs,
        total: rows.length,
        rows: rows.slice(m.offset || 0, (m.offset || 0) + 200).map(view),
        categories: n.categories || { [n.category]: n.bytes },
      },
    });
  }
});
(async () => {
  const rootStat = await fs.lstat(workerData.root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw Error('Select a regular folder, not a link.');
  const stack = [0];
  let next = 1;
  const memoryLimit = workerData.memoryLimit ?? 384 * 1024 * 1024;
  function limited() {
    if (workerData.limit && nodes.size >= workerData.limit)
      limitReason = 'The configured entry limit was reached.';
    else if (nodes.size % 4096 === 0 && process.memoryUsage().heapUsed > memoryLimit)
      limitReason = 'The scan reached its memory budget. Scan a smaller folder to continue.';
    if (!limitReason) return false;
    phase = 'limited';
    cancelled = true;
    return true;
  }
  async function batch(parent, entries) {
    const results = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(parent.path, entry.name);
        try {
          return { entry, full, stat: await fs.lstat(full, { bigint: true }) };
        } catch (error) {
          return { full, error };
        }
      }),
    );
    for (const { entry, full, stat, error } of results) {
      if (cancelled || limited()) break;
      if (error) {
        record(full, error);
        continue;
      }
      if (stat.isSymbolicLink()) {
        links++;
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        skipped++;
        continue;
      }
      const folder = stat.isDirectory(),
        id = next++,
        key = !folder && stat.nlink > 1n && stat.ino !== 0n ? stat.dev + ':' + stat.ino : null,
        linked = key !== null && seen.has(key);
      if (key !== null) seen.add(key);
      const bytes = folder || linked ? 0 : Number(stat.size),
        cat = folder ? null : category(full);
      const node = {
        id,
        parent: parent.id,
        name: entry.name,
        path: full,
        kind: folder ? 'folder' : 'file',
        bytes,
        logical: folder ? null : Number(stat.size),
        category: cat,
        linked,
      };
      if (folder) {
        node.children = [];
        node.categories = Object.fromEntries(Object.keys(categories).map((k) => [k, 0]));
        stack.push(id);
      }
      nodes.set(id, node);
      parent.children.push(id);
      if (!folder) {
        files++;
        if (linked) hardlinks++;
        if (stat.blocks === undefined || process.platform === 'win32') allocatedKnown = false;
        else if (!linked) allocated += Number(stat.blocks) * 512;
        categories[cat] += bytes;
        let p = parent;
        while (p) {
          p.bytes += bytes;
          p.categories[cat] += bytes;
          p = nodes.get(p.parent);
        }
      }
    }
    report();
  }
  while (stack.length && !cancelled) {
    const parent = nodes.get(stack.pop());
    folders++;
    let dir;
    try {
      dir = await fs.opendir(parent.path, { bufferSize: 128 });
    } catch (e) {
      record(parent.path, e);
      continue;
    }
    try {
      let entries = [];
      for await (const entry of dir) {
        if (cancelled) break;
        entries.push(entry);
        if (entries.length === 16) {
          await batch(parent, entries);
          entries = [];
        }
      }
      if (entries.length && !cancelled) await batch(parent, entries);
    } catch (e) {
      record(parent.path, e);
    }
    report();
  }
  if (phase !== 'limited') phase = cancelled ? 'cancelled' : 'complete';
  report(true);
})().catch((error) => {
  phase = 'error';
  errors.push({ path: workerData.root, reason: error.message });
  report(true);
});
