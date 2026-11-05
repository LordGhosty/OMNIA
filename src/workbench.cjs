const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const toolActions = {
  images: ['load', 'convert'],
  metadata: ['metadata-read', 'metadata-write', 'metadata-remove'],
  inspector: ['inspect'],
};
/** Owns temporary file assets and worker jobs. Call close to stop workers and remove scratch files. */
async function createWorkbench() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'omnia-files-'));
  const selections = new Map(),
    jobs = new Map(),
    assets = new Map();
  let current,
    closing = false;
  const view = (job) =>
    job
      ? {
          id: job.id,
          tool: job.tool,
          state: job.state,
          message: job.message,
          percent: job.percent,
          results: job.results,
          error: job.error,
        }
      : null;
  const busy = () => !!current;
  async function clear(tool) {
    if (!toolActions[tool]) throw Error('Unknown file tool.');
    if (busy()) throw Error('Finish or cancel the current file operation first.');
    for (const [id, job] of jobs)
      if (job.tool === tool) {
        if (job.directory)
          await fsp.rm(job.directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        for (const [assetId, asset] of assets)
          if (job.directory && asset.path.startsWith(job.directory + path.sep))
            assets.delete(assetId);
        jobs.delete(id);
      }
    selections.delete(tool);
    return true;
  }
  async function select(tool, paths) {
    if (!toolActions[tool]) throw Error('Unknown file tool.');
    if (busy()) throw Error('Finish or cancel the current file operation first.');
    if (!Array.isArray(paths) || !paths.length || paths.length > (tool === 'images' ? 100 : 1))
      throw Error(tool === 'images' ? 'Select up to 100 images.' : 'Select one file.');
    const list = [];
    let total = 0;
    for (const file of paths) {
      const real = await fsp.realpath(file),
        stat = await fsp.stat(real);
      if (!stat.isFile()) throw Error('Choose regular files.');
      if (tool !== 'inspector' && stat.size > 128 * 1024 * 1024)
        throw Error('Images must be smaller than 128 MiB.');
      total += stat.size;
      if (tool !== 'inspector' && total > 1024 * 1024 * 1024)
        throw Error('Choose a batch of images totaling at most 1 GiB.');
      list.push({
        id: crypto.randomUUID(),
        path: real,
        name: path.basename(real),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
      });
    }
    selections.set(tool, list);
    return list.map(({ ino, mtimeMs, ...item }) => item);
  }
  function register(result) {
    const item = { ...result };
    for (const key of ['preview', 'output'])
      if (item[key]) {
        const file = item[key];
        if (!file.startsWith(root + path.sep)) throw Error('Invalid worker output.');
        const id = crypto.randomUUID();
        assets.set(id, {
          path: file,
          type:
            key === 'preview'
              ? 'image/png'
              : { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[
                  path.extname(file)
                ] || 'application/octet-stream',
          name: item.outputName,
          role: key,
        });
        item[key] = id;
      }
    return item;
  }
  async function start(tool, action, options = {}) {
    if (closing) throw Error('OMNIA is closing.');
    if (busy()) throw Error('Another file operation is running.');
    if (!toolActions[tool]?.includes(action)) throw Error('Unsupported file operation.');
    if (!options || typeof options !== 'object' || JSON.stringify(options).length > 100000)
      throw Error('Invalid options.');
    const sources = selections.get(tool);
    if (!sources?.length) throw Error('Choose a file first.');
    const job = {
      id: crypto.randomUUID(),
      tool,
      state: 'running',
      message: 'Preparing files…',
      percent: 0,
      results: [],
    };
    current = job;
    jobs.set(job.id, job);
    try {
      // Per-tool output retention.
      for (const [id, old] of jobs)
        if (id !== job.id && old.tool === tool) {
          for (const [assetId, asset] of assets)
            if (asset.path.startsWith(old.directory + path.sep)) assets.delete(assetId);
          if (old.directory)
            await fsp.rm(old.directory, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 200,
            });
          jobs.delete(id);
        }
      job.directory = path.join(root, job.id);
      await fsp.mkdir(job.directory);
      if (closing) throw Error('OMNIA is closing.');
      const worker = new Worker(path.join(__dirname, 'workbench-worker.cjs'), {
        workerData: { action, sources, options, directory: job.directory },
      });
      job.worker = worker;
      job.finished = new Promise((resolve) => {
        worker.on('message', (message) => {
          if (message.type === 'progress') {
            job.message = message.message;
            job.percent = message.percent;
          }
          if (message.type === 'item' && job.state !== 'cancelling') {
            try {
              job.results.push(register(message.item));
            } catch (error) {
              job.error = error.message;
              worker.postMessage('cancel');
            }
          }
          if (message.type === 'failed') {
            job.error = message.error;
            job.state = message.cancelled ? 'cancelled' : 'error';
          }
        });
        worker.on('error', (error) => {
          job.error = error.message;
          job.state = 'error';
        });
        worker.on('exit', (code) => {
          if (job.state === 'cancelling') job.state = 'cancelled';
          else if (job.state === 'running') job.state = code === 0 && !job.error ? 'done' : 'error';
          job.percent = job.state === 'done' ? 100 : job.percent;
          job.message =
            job.state === 'done'
              ? `${job.results.filter((x) => !x.error).length} / ${sources.length} files ready`
              : job.state === 'cancelled'
                ? 'Cancelled.'
                : job.error || 'The operation stopped.';
          current = null;
          job.worker = null;
          resolve();
        });
      });
      return view(job);
    } catch (error) {
      current = null;
      job.state = 'error';
      job.error = error.message;
      throw error;
    }
  }
  function cancel(id) {
    const job = jobs.get(id);
    if (job === current && job.worker) {
      job.state = 'cancelling';
      job.message = 'Cancelling after the current file operation…';
      job.worker.postMessage('cancel');
    }
    return view(job);
  }
  async function save(id, destination) {
    const asset = assets.get(id);
    if (!asset || asset.role !== 'output') throw Error('This result is no longer available.');
    if (busy()) throw Error('Wait for the file operation to finish.');
    // Exclusive destination creation.
    try {
      await fsp.copyFile(asset.path, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw Error(
          'A file already exists there. Choose a new name; original files are never overwritten.',
        );
      throw error;
    }
    return { path: destination, bytes: (await fsp.stat(destination)).size };
  }
  async function saveBatch(ids, folder) {
    if (!Array.isArray(ids) || ids.length > 100 || !ids.length) throw Error('No outputs to save.');
    const result = [];
    for (const id of ids) {
      const asset = assets.get(id);
      if (!asset || asset.role !== 'output') throw Error('An output expired. Convert again.');
      const parsed = path.parse(path.basename(asset.name));
      let saved;
      for (let n = 0; n < 1000; n++) {
        const destination = path.join(folder, parsed.name + (n ? '-' + n : '') + parsed.ext);
        try {
          saved = await save(id, destination);
          break;
        } catch (error) {
          if (!error.message.startsWith('A file already exists')) throw error;
        }
      }
      if (!saved) throw Error('Could not find a free output filename.');
      result.push(saved);
    }
    return result;
  }
  return {
    select,
    clear,
    start,
    cancel,
    save,
    saveBatch,
    isBusy: busy,
    asset: (id) => assets.get(id),
    source: (tool, id) => selections.get(tool)?.find((item) => item.id === id),
    status: (id) => view(jobs.get(id)),
    async close() {
      closing = true;
      if (current) {
        cancel(current.id);
        await current.finished;
      }
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
module.exports = { createWorkbench, toolActions };
