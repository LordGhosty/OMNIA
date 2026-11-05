const { Worker } = require('node:worker_threads');
const path = require('node:path'),
  fs = require('node:fs/promises'),
  crypto = require('node:crypto');
const { readScript } = require('./system-read.cjs');
/** Scans selected paths in a worker and exposes inventory, progress and cancellation. */
function createDiskSpace({
  inventoryFn = () => readScript('storage-inventory.ps1'),
  platform = process.platform,
  limit,
  memoryLimit,
  statfs = fs.statfs,
} = {}) {
  let inventory = null,
    worker = null,
    scan = null,
    loading = false,
    starting = false;
  const requests = new Map();
  const status = () => ({ inventory, scan, loading, starting, supported: platform === 'win32' });
  async function refresh() {
    if (loading) throw Error('Disk detection is already running.');
    loading = true;
    try {
      inventory =
        platform === 'win32'
          ? await inventoryFn()
          : {
              disks: [],
              volumes: [],
              issues: ['Drive inventory currently supports Windows. Choose a folder to scan.'],
            };
    } finally {
      loading = false;
    }
    return status();
  }
  async function start(root) {
    if (starting || scan?.phase === 'scanning') throw Error('Cancel the current scan first.');
    starting = true;
    try {
      await close();
      root = path.resolve(root);
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Select a regular folder.');
      let capacity = null;
      try {
        const info = await statfs(root);
        const total = info.bsize * info.blocks;
        const free = Math.max(0, Math.min(total, info.bsize * info.bfree));
        if (Number.isFinite(total) && total > 0 && Number.isFinite(free))
          capacity = { total, free, used: total - free, checkedAt: new Date().toISOString() };
      } catch {
        // Some filesystems do not expose volume capacity.
      }
      scan = {
        phase: 'scanning',
        root,
        bytes: 0,
        files: 0,
        folders: 0,
        skipped: 0,
        categories: {},
        capacity,
      };
      const current = (worker = new Worker(path.join(__dirname, 'disk-scan-worker.cjs'), {
        workerData: { root, limit, memoryLimit },
      }));
      current.on('message', (m) => {
        if (current !== worker) return;
        if (m.type === 'status') scan = { ...m.status, capacity };
        else if (m.type === 'reply') {
          const r = requests.get(m.request);
          if (r) {
            requests.delete(m.request);
            clearTimeout(r.timer);
            m.error ? r.reject(Error(m.error)) : r.resolve(m.value);
          }
        }
      });
      current.on('error', (e) => {
        if (current === worker) {
          scan = { ...scan, phase: 'error', issues: [{ reason: e.message }] };
          rejectRequests(e);
        }
      });
    } finally {
      starting = false;
    }
    return status();
  }
  function rejectRequests(error) {
    for (const r of requests.values()) {
      clearTimeout(r.timer);
      r.reject(error);
    }
    requests.clear();
  }
  function query(id, offset = 0, sort = 'size', location = false) {
    if (
      !worker ||
      !Number.isInteger(id) ||
      id < 0 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !['size', 'name'].includes(sort)
    )
      throw Error('Select a scan entry.');
    return new Promise((resolve, reject) => {
      const request = crypto.randomUUID(),
        timer = setTimeout(() => {
          requests.delete(request);
          reject(Error('Scan entry request timed out.'));
        }, 10000);
      requests.set(request, { resolve, reject, timer });
      worker.postMessage({ type: 'query', request, id, offset, sort, location });
    });
  }
  async function startVolume(id) {
    if (!inventory) await refresh();
    const volume = inventory.volumes.find((v) => v.id === id);
    if (!volume?.root || !volume.size)
      throw Error(
        'This volume has no accessible drive letter. Use Windows Disk Management for volume controls.',
      );
    return start(volume.root);
  }
  function cancel() {
    worker?.postMessage({ type: 'cancel' });
    return status();
  }
  async function close() {
    const previous = worker;
    worker = null;
    rejectRequests(Error('Scan cleared.'));
    if (previous) await previous.terminate();
    scan = null;
  }
  return { status, refresh, start, startVolume, query, cancel, close };
}
module.exports = { createDiskSpace };
