const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Worker } = require('node:worker_threads'),
  { spawn } = require('node:child_process'),
  readline = require('node:readline');
const kinds = ['rename', 'duplicates', 'search'];
const { createLocations, pathError } = require('./file-locations.cjs');
const { nameMatcher } = require('./file-match.cjs');
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const identity = (s) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: String(s.size),
  mtime: String(s.mtimeNs),
});
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function verify(f, p = f.path) {
  const s = await fs.lstat(p, { bigint: true });
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    !same(f.identity, identity(s)) ||
    key(await fs.realpath(path.dirname(p))) !== key(f.parent)
  )
    throw Error('File changed: ' + p);
}
function filename(f, r, index) {
  const ext = path.extname(f.name);
  let base = f.name.slice(0, f.name.length - ext.length);
  if (r.find) base = base.split(r.find).join(r.replace || '');
  let name = (r.pattern || '{name}').replace(/\{(name|n|date)\}/g, (_, token) =>
    token === 'name'
      ? base
      : token === 'n'
        ? String((r.start ?? 1) + index).padStart(r.padding ?? 3, '0')
        : new Date(f.modified).toISOString().slice(0, 10),
  );
  if (r.case === 'lower') name = name.toLowerCase();
  if (r.case === 'upper') name = name.toUpperCase();
  name = (r.prefix || '') + name + (r.suffix || '') + ext;
  if (
    !name ||
    name.length > 240 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw Error('Invalid filename: ' + name);
  return name;
}
function mover() {
  if (process.platform !== 'win32')
    return {
      async move(from, to) {
        await fs.link(from, to);
        await fs.unlink(from);
      },
      close() {},
    };
  const child = spawn(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(
        require('node:fs').readFileSync(path.join(__dirname, 'file-move.ps1'), 'utf8'),
        'utf16le',
      ).toString('base64'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let pending, failure;
  const fail = (e) => {
    failure = e;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(e);
      pending = null;
    }
  };
  child.on('error', fail);
  child.on('exit', () => fail(Error('The file operation ended.')));
  child.stderr.on('data', () => {});
  child.stdin.on('error', fail);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    try {
      const result = JSON.parse(line);
      result.error ? p.reject(Error(result.error)) : p.resolve();
    } catch {
      p.reject(Error('Invalid file operation response.'));
    }
  });
  return {
    move(from, to) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            fail(Error('File operation timed out. Review recovery history.'));
            child.kill();
          }, 30000),
        };
        child.stdin.write(JSON.stringify({ from, to }) + '\n');
      });
    },
    close() {
      child.stdin.end();
    },
  };
}
/** Manages file-tool sessions and reviewed changes. Rename journals are stored in journalDir. */
function createFileTools({
  journalDir,
  trash = async () => {
    throw Error('Trash is unavailable.');
  },
  moveFactory = mover,
  limit,
  places,
  drives,
} = {}) {
  const locations = createLocations({ places, drives });
  const sessions = new Map(
    kinds.map((k) => [k, { roots: [], files: [], groups: [], state: { phase: 'idle' } }]),
  );
  let worker = null,
    active = null,
    busy = false,
    requesting = false,
    preview = null;
  const get = (tool) => {
    if (!sessions.has(tool)) throw Error('Unknown file tool.');
    return sessions.get(tool);
  };
  const status = (tool) => {
    const s = get(tool);
    return { roots: s.roots, state: s.state, count: s.files.length, groups: s.groups.length, busy };
  };
  const idle = () => {
    if (busy || worker) throw Error('Finish or cancel the current file operation first.');
  };
  function reset(s) {
    s.files = [];
    s.groups = [];
    s.orders = null;
    s.byId = null;
    s.byGroup = null;
    s.state = { phase: 'idle' };
    preview = null;
  }
  async function select(tool, paths) {
    idle();
    const s = get(tool);
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000)
      throw Error('Choose files or folders.');
    const roots = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw Error('Choose a local path.');
      const st = await fs.lstat(p).catch((error) => {
        throw pathError(error);
      });
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))
        throw Error('Choose regular files or folders.');
      roots.push(await fs.realpath(p));
    }
    s.roots = [...new Map([...s.roots, ...roots].map((p) => [key(p), p])).values()];
    reset(s);
    return status(tool);
  }
  function remove(tool, root) {
    idle();
    const s = get(tool);
    s.roots = s.roots.filter((p) => p !== root);
    reset(s);
    return status(tool);
  }
  function start(tool, options = {}) {
    idle();
    const s = get(tool);
    if (!s.roots.length)
      throw Error('Choose a location from the folder list, or use Browse folders.');
    nameMatcher(options.name, options.match, options.caseSensitive);
    if (options.exclude) nameMatcher(options.exclude, 'auto', options.caseSensitive);
    if (options.kind && !['all', 'files', 'folders'].includes(options.kind))
      throw Error('Choose files, folders, or both.');
    for (const field of ['minBytes', 'maxBytes', 'after', 'before'])
      if (options[field] != null && (!Number.isFinite(options[field]) || options[field] < 0))
        throw Error('Enter valid size and date filters.');
    if (
      (options.minBytes != null &&
        options.maxBytes != null &&
        options.minBytes > options.maxBytes) ||
      (options.after != null && options.before != null && options.after > options.before)
    )
      throw Error('The minimum must not exceed the maximum.');
    if (String(options.name || '').length > 240 || String(options.extensions || '').length > 1000)
      throw Error('Shorten the search filters.');
    preview = null;
    s.files = [];
    s.groups = [];
    s.orders = null;
    s.byId = null;
    s.byGroup = null;
    s.state = { phase: 'scanning', visited: 0 };
    active = tool;
    const w = (worker = new Worker(path.join(__dirname, 'file-tools-worker.cjs'), {
      workerData: { roots: s.roots, tool, options, limit },
    }));
    w.on('message', (m) => {
      if (w !== worker) return;
      s.state = m.state;
      if (m.type === 'results') {
        s.files.push(...m.files);
        s.orders ||= { name: [], size: [], date: [] };
        s.byId ||= new Map();
        for (const f of m.files) {
          s.byId.set(f.id, f);
          for (const order of Object.values(s.orders)) order.push(f.id);
        }
      }
      if (m.type === 'done') {
        s.files = m.files;
        s.groups = m.groups;
        s.orders = m.orders;
        s.byId = new Map(m.files.map((f) => [f.id, f]));
        s.byGroup = new Map(m.groups.map((g) => [g.id, g]));
        worker = null;
        active = null;
      }
    });
    w.on('error', (e) => {
      if (w === worker) {
        s.state = { phase: 'error', issues: [{ reason: e.message }] };
        worker = null;
        active = null;
      }
    });
    w.on('exit', () => {
      if (w !== worker) return;
      s.state = {
        ...s.state,
        phase: 'error',
        issues: [{ reason: 'The scan stopped unexpectedly. Try scanning this location again.' }],
      };
      worker = null;
      active = null;
    });
    return status(tool);
  }
  function query(tool, { offset = 0, group, sort = 'name' } = {}) {
    const s = get(tool);
    if (!Number.isInteger(offset) || offset < 0 || !['name', 'size', 'date'].includes(sort))
      throw Error('Invalid result page.');
    let ids = s.orders?.[sort] || [];
    if (group) {
      const members = new Set(s.byGroup?.get(group)?.files || []);
      ids = ids.filter((id) => members.has(id));
    }
    return {
      rows: ids.slice(offset, offset + 100).map((id) => {
        const { identity, parent, hash, ...f } = s.byId.get(id);
        return f;
      }),
      total: ids.length,
      groups:
        tool === 'duplicates'
          ? s.groups
              .slice(offset, offset + 100)
              .map((g) => ({ ...g, name: s.byId.get(g.files[0])?.name }))
          : undefined,
      groupCount: s.groups.length,
    };
  }
  async function clear(tool) {
    if (busy) throw Error('Wait for the file operation.');
    get(tool);
    if (active === tool) {
      const w = worker;
      worker = null;
      active = null;
      await w.terminate();
    }
    sessions.set(tool, { roots: [], files: [], groups: [], state: { phase: 'idle' } });
    preview = null;
    return status(tool);
  }
  function cancel(tool) {
    get(tool);
    if (active === tool) worker?.postMessage('cancel');
    return status(tool);
  }
  async function location(tool, id) {
    const f = get(tool).files.find((f) => f.id === id);
    if (!f) throw Error('Scan again to locate this file.');
    if (f.kind === 'folder') {
      const stat = await fs.lstat(f.path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('This folder moved or changed. Search again.');
    } else await verify(f);
    return f.path;
  }
  async function preflight(rows) {
    const sources = new Set(rows.map((r) => key(r.from))),
      targets = new Set();
    for (const r of rows) {
      if (r.identity.ino === '0')
        throw Error('This filesystem does not report a stable file identity.');
      await verify(r, r.from);
      if (targets.has(key(r.to))) throw Error('Multiple files would have the same name: ' + r.to);
      targets.add(key(r.to));
      if ((await exists(r.to)) && !sources.has(key(r.to)))
        throw Error('A file already exists: ' + r.to);
    }
  }
  async function prepareRename(rules = {}) {
    idle();
    const s = get('rename');
    if (s.state.phase !== 'complete' || s.state.skipped)
      throw Error('Complete a scan without skipped files before renaming.');
    if (
      !Number.isSafeInteger(rules.start ?? 1) ||
      (rules.start ?? 1) < 0 ||
      !Number.isInteger(rules.padding ?? 3) ||
      (rules.padding ?? 3) < 1 ||
      (rules.padding ?? 3) > 12
    )
      throw Error('Use a non-negative start and 1–12 digit padding.');
    for (const k of ['pattern', 'prefix', 'suffix', 'find', 'replace'])
      if (rules[k] != null && (typeof rules[k] !== 'string' || rules[k].length > 240))
        throw Error('Shorten the rename rules.');
    const rows = s.files
      .map((f, i) => ({
        ...f,
        from: f.path,
        to: path.join(path.dirname(f.path), filename(f, rules, i)),
      }))
      .filter((r) => r.from !== r.to);
    if (!rows.length) throw Error('No filenames would change.');
    await preflight(rows);
    preview = { kind: 'rename', token: crypto.randomUUID(), expires: Date.now() + 300000, rows };
    return {
      token: preview.token,
      count: rows.length,
      rows: rows.map((r) => ({ from: r.from, to: r.to })),
    };
  }
  async function writeJournal(j) {
    await fs.mkdir(journalDir, { recursive: true });
    const handle = await fs.open(path.join(journalDir, j.id + '.json'), 'wx');
    try {
      await handle.writeFile(JSON.stringify(j));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function transact(rows, undoOf) {
    await preflight(rows);
    const id = crypto.randomUUID(),
      j = {
        id,
        date: new Date().toISOString(),
        undoOf,
        rows: rows.map((r) => ({
          ...r,
          temp: path.join(path.dirname(r.from), '.omnia-rename-' + crypto.randomUUID()),
        })),
      };
    await writeJournal(j);
    const m = moveFactory();
    try {
      for (const r of j.rows) {
        await verify(r, r.from);
        await m.move(r.from, r.temp);
      }
      for (const r of j.rows) {
        await verify(r, r.temp);
        await m.move(r.temp, r.to);
      }
      await fs.writeFile(path.join(journalDir, id + '.done'), 'complete', { flag: 'wx' });
      return { id, count: rows.length, message: `Renamed ${rows.length} files.` };
    } catch (e) {
      throw Error(e.message + ' Open rename history to review recovery.');
    } finally {
      m.close();
    }
  }
  async function history() {
    await fs.mkdir(journalDir, { recursive: true });
    const entries = (await fs.readdir(journalDir)).filter((f) => /^[a-f0-9-]+\.json$/.test(f)),
      rows = [];
    for (const name of entries) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(journalDir, name), 'utf8'));
        rows.push({
          id: j.id,
          date: j.date,
          count: j.rows.length,
          undoOf: j.undoOf,
          complete: await exists(path.join(journalDir, j.id + '.done')),
        });
      } catch {}
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }
  async function prepareUndo(id) {
    idle();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Select a history entry.');
    const j = JSON.parse(await fs.readFile(path.join(journalDir, id + '.json'), 'utf8')),
      rows = [];
    for (const r of j.rows) {
      let current;
      for (const candidate of [...new Set([r.to, r.temp, r.from])]) {
        try {
          await verify(r, candidate);
          current = candidate;
          break;
        } catch {}
      }
      if (!current) throw Error('A renamed file changed or moved. Recovery stopped: ' + r.from);
      if (current !== r.from) rows.push({ ...r, from: current, to: r.from });
    }
    if (!rows.length) throw Error('These files already have their original names.');
    await preflight(rows);
    preview = {
      kind: 'undo',
      undoOf: id,
      token: crypto.randomUUID(),
      expires: Date.now() + 300000,
      rows,
    };
    return {
      token: preview.token,
      count: rows.length,
      rows: rows.map((r) => ({ from: r.from, to: r.to })),
    };
  }
  async function prepareTrash(ids) {
    idle();
    const s = get('duplicates');
    if (!['complete', 'partial'].includes(s.state.phase))
      throw Error('Finish the duplicate scan first.');
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000 ||
      new Set(ids).size !== ids.length
    )
      throw Error('Select duplicate copies.');
    const selected = new Set(ids),
      rows = [];
    for (const id of ids) {
      const f = s.files.find((f) => f.id === id),
        g = s.groups.find((g) => g.files.includes(id)),
        keeper = g && s.files.find((f) => g.files.includes(f.id) && !selected.has(f.id));
      if (!f || !keeper) throw Error('Keep at least one file in each duplicate group.');
      rows.push({ ...f, keeper });
    }
    preview = { kind: 'trash', token: crypto.randomUUID(), expires: Date.now() + 300000, rows };
    return {
      token: preview.token,
      count: rows.length,
      bytes: rows.reduce((n, r) => n + r.size, 0),
      rows: rows.map((r) => ({ from: r.path, to: 'Keep: ' + r.keeper.path })),
    };
  }
  async function compare(a, b) {
    await verify(a);
    await verify(b);
    const handles = [];
    try {
      handles.push(await fs.open(a.path, 'r'));
      handles.push(await fs.open(b.path, 'r'));
      const buffers = [Buffer.allocUnsafe(262144), Buffer.allocUnsafe(262144)];
      let pos = 0;
      while (true) {
        const r = await Promise.all(
          handles.map((h, i) => h.read(buffers[i], 0, buffers[i].length, pos)),
        );
        if (
          r[0].bytesRead !== r[1].bytesRead ||
          !buffers[0].subarray(0, r[0].bytesRead).equals(buffers[1].subarray(0, r[1].bytesRead))
        )
          throw Error('File contents no longer match.');
        if (!r[0].bytesRead) break;
        pos += r[0].bytesRead;
      }
      await verify(a);
      await verify(b);
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  }
  async function execute(token) {
    idle();
    const p = preview;
    preview = null;
    if (!p || p.token !== token || p.expires < Date.now())
      throw Error('Review this operation again.');
    busy = true;
    try {
      if (p.kind === 'trash') {
        const results = [];
        for (const f of p.rows) {
          try {
            await compare(f, f.keeper);
            await trash(f.path);
            results.push({ path: f.path, ok: true });
          } catch (e) {
            results.push({ path: f.path, ok: false, error: e.message });
          }
        }
        get('duplicates').state.phase = 'stale';
        return {
          message: `Moved ${results.filter((r) => r.ok).length} of ${results.length} files to trash. Scan again before making more changes.`,
          results,
        };
      }
      const result = await transact(p.rows, p.undoOf);
      get('rename').state.phase = 'stale';
      return result;
    } finally {
      busy = false;
    }
  }
  async function close() {
    if (worker) await worker.terminate();
    worker = null;
  }
  const exclusive =
    (fn) =>
    async (...args) => {
      if (requesting) throw Error('Wait for the current file request.');
      requesting = true;
      try {
        return await fn(...args);
      } finally {
        requesting = false;
      }
    };
  return {
    status,
    roots: (tool, part) => {
      get(tool);
      return locations.roots(part);
    },
    folders: (tool, folder, offset) => {
      get(tool);
      return locations.children(folder, offset);
    },
    remove: exclusive(remove),
    select: exclusive(select),
    start: exclusive(start),
    query,
    clear: exclusive(clear),
    cancel,
    location,
    prepareRename: exclusive(prepareRename),
    prepareUndo: exclusive(prepareUndo),
    prepareTrash: exclusive(prepareTrash),
    execute: exclusive(execute),
    history,
    close,
    isBusy: () => busy || requesting,
  };
}
module.exports = { createFileTools, filename, mover };
