const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createDiskSpace } = require('../src/diskspace.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function finish(service) {
  for (let i = 0; i < 500 && service.status().scan.phase === 'scanning'; i++) await pause(10);
  assert.equal(service.status().scan.phase, 'complete');
  return service.status().scan;
}

test('volume scans reuse inventory and report capacity separately from logical file sizes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-capacity-'));
  let reads = 0;
  const service = createDiskSpace({
    platform: 'win32',
    inventoryFn: async () => {
      reads++;
      return { disks: [], volumes: [{ id: 'volume', root, size: 1000 }], issues: [] };
    },
    statfs: async () => ({ bsize: 1, blocks: 1000, bfree: 400 }),
  });
  try {
    await fs.writeFile(path.join(root, 'document.txt'), 'abc');
    const detection = service.refresh();
    assert.equal(service.isBusy(), true);
    assert.equal((await detection).loading, false);
    assert.equal(service.isBusy(), false);
    const initial = await service.startVolume('volume');
    assert.equal(service.isBusy(), true);
    assert.equal(initial.scan.capacity.free, 400);
    assert.equal(initial.scan.capacity.used, 600);
    assert.equal(initial.starting, false);
    const result = await finish(service);
    assert.equal(service.isBusy(), false);
    assert.equal(result.bytes, 3);
    assert.equal(result.capacity.total, 1000);
    assert.equal(reads, 1);
    await assert.rejects(service.startVolume('removed'), /no accessible/);
    assert.equal(reads, 1);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing capacity does not prevent scanning and repeated starts cannot create concurrent workers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-capacity-unavailable-'));
  const service = createDiskSpace({
    statfs: async () => {
      throw Error('Unavailable');
    },
  });
  try {
    const pending = service.start(root);
    await assert.rejects(service.start(root), /current scan/);
    await pending;
    assert.equal((await finish(service)).capacity, null);
    assert.equal(service.status().starting, false);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function syntheticScan(count, memoryLimit) {
  const code = `
    const fs = require('node:fs/promises');
    const { workerData } = require('node:worker_threads');
    fs.lstat = async p => ({
      isDirectory: () => p === workerData.root,
      isFile: () => p !== workerData.root,
      isSymbolicLink: () => false,
      dev: 1n, ino: 1n, nlink: 1n, size: 8n, blocks: 1n,
    });
    fs.opendir = async () => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < workerData.count; i++) {
          if (i % 2048 === 0) await new Promise(setImmediate);
          yield { name: 'file-' + i + '.txt' };
        }
      },
    });
    require(workerData.module);
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: {
        count,
        root: path.resolve('fixture-volume'),
        memoryLimit,
        module: path.resolve(__dirname, '../src/disk-scan-worker.cjs'),
      },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Error('Synthetic scan timed out'));
    }, 30000);
    worker.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.on('message', (message) => {
      if (message.type !== 'status' || message.status.phase === 'scanning') return;
      clearTimeout(timer);
      worker.terminate().then(() => resolve(message.status), reject);
    });
  });
}

test('disk scans pass the previous 200,000-entry cutoff', async () => {
  const result = await syntheticScan(201000);
  assert.equal(result.phase, 'complete');
  assert.equal(result.files, 201000);
  assert.equal(result.bytes, 201000 * 8);
  assert.equal(result.categories.documents, result.bytes);
  assert.equal(result.hardlinks, 0);
});

test('scan memory budget produces explicit partial coverage', async () => {
  const result = await syntheticScan(5000, 1);
  assert.equal(result.phase, 'limited');
  assert.match(result.limitReason, /memory budget/);
  assert.ok(result.files < 5000);
});
