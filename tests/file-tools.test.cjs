const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { createFileTools, filename } = require('../src/file-tools.cjs');
const { nameMatcher } = require('../src/file-match.cjs');
const { createLocations } = require('../src/file-locations.cjs');
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-files-')),
    data = path.join(root, 'files');
  await fs.mkdir(data);
  const journalDir = path.join(root, 'history');
  const service = createFileTools({ journalDir, ...options });
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, data, service, journalDir };
}
async function wait(service, tool) {
  for (let i = 0; i < 1000; i++) {
    const s = service.status(tool);
    if (!['scanning', 'comparing'].includes(s.state.phase)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Scan timed out.');
}
async function scan(service, tool, files, options = { recursive: true }) {
  await service.select(tool, files);
  service.start(tool, options);
  return wait(service, tool);
}
const linkMover = () => ({
  async move(a, b) {
    await fs.link(a, b);
    await fs.unlink(a);
  },
  close() {},
});
test('rename patterns preserve extensions and validate reserved/path names', () => {
  const file = { name: 'Photo.JPG', modified: 0 };
  assert.equal(
    filename(file, { pattern: '{date}-{n}-{name}', start: 7, padding: 3, case: 'lower' }, 0),
    '1970-01-01-007-photo.JPG',
  );
  assert.throws(() => filename(file, { pattern: '../x' }, 0));
  assert.throws(() => filename(file, { pattern: 'CON' }, 0));
});
test('batch rename applies and survives a restart for undo', async (t) => {
  const { data, service, journalDir } = await setup(t, { moveFactory: linkMover });
  await fs.writeFile(path.join(data, 'a.txt'), 'a');
  await fs.writeFile(path.join(data, 'b.txt'), 'b');
  await scan(service, 'rename', [data]);
  const plan = await service.prepareRename({ pattern: 'file-{n}', start: 1, padding: 2 });
  assert.equal(plan.count, 2);
  const result = await service.execute(plan.token);
  assert.equal(await fs.readFile(path.join(data, 'file-01.txt'), 'utf8'), 'a');
  const reopened = createFileTools({ journalDir, moveFactory: linkMover });
  t.after(() => reopened.close());
  const undo = await reopened.prepareUndo(result.id);
  await reopened.execute(undo.token);
  assert.deepEqual((await fs.readdir(data)).sort(), ['a.txt', 'b.txt']);
  await assert.rejects(() => service.execute(plan.token), /Review/);
});
test('rename detects collisions and edited sources', async (t) => {
  const { data, service } = await setup(t, { moveFactory: linkMover });
  await fs.writeFile(path.join(data, 'a.txt'), 'a');
  await fs.writeFile(path.join(data, 'b.txt'), 'b');
  await scan(service, 'rename', [data]);
  await assert.rejects(() => service.prepareRename({ pattern: 'same' }), /same name/);
  const plan = await service.prepareRename({ prefix: 'new-' });
  await fs.writeFile(path.join(data, 'a.txt'), 'changed');
  await assert.rejects(() => service.execute(plan.token), /changed/);
  assert.equal(await fs.readFile(path.join(data, 'b.txt'), 'utf8'), 'b');
});
test('interrupted rename can recover without replacing a destination', async (t) => {
  let moves = 0;
  const { data, service, journalDir } = await setup(t, {
    moveFactory: () => ({
      async move(a, b) {
        if (++moves === 3) {
          await fs.writeFile(b, 'external', { flag: 'wx' });
          throw Error('Destination exists.');
        }
        await fs.link(a, b);
        await fs.unlink(a);
      },
      close() {},
    }),
  });
  await fs.writeFile(path.join(data, 'a.txt'), 'a');
  await fs.writeFile(path.join(data, 'b.txt'), 'b');
  await scan(service, 'rename', [data]);
  const plan = await service.prepareRename({ prefix: 'new-' });
  await assert.rejects(() => service.execute(plan.token), /recovery/);
  assert.equal(await fs.readFile(path.join(data, 'new-a.txt'), 'utf8'), 'external');
  const history = await service.history();
  assert.equal(history[0].complete, false);
  const reopened = createFileTools({ journalDir, moveFactory: linkMover });
  t.after(() => reopened.close());
  const undo = await reopened.prepareUndo(history[0].id);
  await reopened.execute(undo.token);
  assert.equal(await fs.readFile(path.join(data, 'a.txt'), 'utf8'), 'a');
  assert.equal(await fs.readFile(path.join(data, 'new-a.txt'), 'utf8'), 'external');
});
test('undo refuses external changes and existing names', async (t) => {
  const { data, service } = await setup(t, { moveFactory: linkMover });
  await fs.writeFile(path.join(data, 'a.txt'), 'a');
  await scan(service, 'rename', [data]);
  const plan = await service.prepareRename({ prefix: 'new-' });
  const done = await service.execute(plan.token);
  await fs.writeFile(path.join(data, 'a.txt'), 'other');
  await assert.rejects(() => service.prepareUndo(done.id), /already exists/);
});
test('duplicate comparison excludes same-size different contents and keeps a survivor', async (t) => {
  const recycled = [];
  const { data, service } = await setup(t, {
    trash: async (file) => {
      recycled.push(file);
      await fs.rename(file, file + '.trashed');
    },
  });
  await fs.writeFile(path.join(data, 'a.txt'), 'match');
  await fs.writeFile(path.join(data, 'b.txt'), 'match');
  await fs.writeFile(path.join(data, 'c.txt'), 'other');
  await scan(service, 'duplicates', [data]);
  const q = service.query('duplicates');
  assert.equal(q.groupCount, 1);
  assert.equal(q.groups[0].files.length, 2);
  await assert.rejects(() => service.prepareTrash(q.groups[0].files), /Keep at least one/);
  const plan = await service.prepareTrash([q.groups[0].files[1]]);
  const result = await service.execute(plan.token);
  assert.equal(result.results[0].ok, true);
  assert.equal(recycled.length, 1);
  assert.equal(await fs.readFile(path.join(data, 'a.txt'), 'utf8'), 'match');
});
test('duplicate removal rechecks the kept copy', async (t) => {
  let called = false;
  const { data, service } = await setup(t, {
    trash: async () => {
      called = true;
    },
  });
  await fs.writeFile(path.join(data, 'a.txt'), 'match');
  await fs.writeFile(path.join(data, 'b.txt'), 'match');
  await scan(service, 'duplicates', [data]);
  const g = service.query('duplicates').groups[0],
    plan = await service.prepareTrash([g.files[1]]);
  await fs.writeFile(path.join(data, 'a.txt'), 'changed');
  const result = await service.execute(plan.token);
  assert.equal(called, false);
  assert.equal(result.results[0].ok, false);
});
test('search filters files, paginates and reports scan limits', async (t) => {
  const { data, service } = await setup(t, { limit: 2 });
  await fs.mkdir(path.join(data, 'nested'));
  await fs.writeFile(path.join(data, 'match.txt'), 'abc');
  await fs.writeFile(path.join(data, 'nested', 'match2.txt'), 'abcd');
  await fs.writeFile(path.join(data, 'skip.png'), 'abc');
  await scan(service, 'search', [data], {
    recursive: true,
    name: 'match',
    extensions: '.txt',
    minBytes: 3,
    maxBytes: 4,
  });
  assert.equal(service.query('search').total, 2);
  await service.clear('search');
  await scan(service, 'search', [data]);
  assert.equal(service.status('search').state.phase, 'partial');
  await assert.rejects(() => service.location('search', 'bad-id'), /Scan again/);
  await assert.rejects(() => service.start('search', { minBytes: 10, maxBytes: 1 }), /minimum/);
});
test('rename blocks partial scans and cancellation leaves sources unchanged', async (t) => {
  const { data, service } = await setup(t, { limit: 1 });
  await fs.writeFile(path.join(data, 'a.txt'), 'a');
  await fs.writeFile(path.join(data, 'b.txt'), 'b');
  await scan(service, 'rename', [data]);
  await assert.rejects(() => service.prepareRename({ prefix: 'x' }), /Complete a scan/);
  await service.clear('rename');
  await service.select('search', [data]);
  service.start('search', { recursive: true });
  service.cancel('search');
  await wait(service, 'search');
  assert.deepEqual((await fs.readdir(data)).sort(), ['a.txt', 'b.txt']);
});
test(
  'native Windows moves support case-only names without overwrite',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { data, service } = await setup(t);
    await fs.writeFile(path.join(data, 'File.txt'), 'data');
    await scan(service, 'rename', [data]);
    const plan = await service.prepareRename({ case: 'lower' });
    const result = await service.execute(plan.token);
    assert.deepEqual(await fs.readdir(data), ['file.txt']);
    const undo = await service.prepareUndo(result.id);
    await service.execute(undo.token);
    assert.deepEqual(await fs.readdir(data), ['File.txt']);
  },
);
test('links and hard links are excluded from duplicate and rename changes', async (t) => {
  const { data, service } = await setup(t);
  await fs.mkdir(path.join(data, 'target'));
  await fs.writeFile(path.join(data, 'source.txt'), 'same');
  await fs.link(path.join(data, 'source.txt'), path.join(data, 'linked.txt'));
  await fs.symlink(
    path.join(data, 'target'),
    path.join(data, 'shortcut'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await scan(service, 'duplicates', [data]);
  assert.equal(service.query('duplicates').groupCount, 0);
  assert.equal(service.status('duplicates').state.skipped, 3);
  await scan(service, 'rename', [data]);
  await assert.rejects(() => service.prepareRename({ prefix: 'x' }), /without skipped/);
});
test('result ordering and dates remain stable across pages and selections', async (t) => {
  const { data, service } = await setup(t);
  const stamp = new Date('2020-01-02T00:00:00Z');
  for (let i = 0; i < 105; i++) {
    const p = path.join(data, String(i).padStart(3, '0') + '.txt');
    await fs.writeFile(p, Buffer.alloc(i));
    await fs.utimes(p, stamp, stamp);
  }
  await scan(service, 'search', [data], { recursive: true, after: +stamp, before: +stamp });
  assert.equal(service.query('search', { offset: 100 }).rows.length, 5);
  assert.equal(service.query('search', { sort: 'size' }).rows[0].size, 104);
  await service.select('search', [path.join(data, '000.txt')]);
  assert.equal(service.query('search').total, 0);
});

test('name matching supports wildcard, exact, alternatives and literal modes', () => {
  for (const [query, name, expected] of [
    ['report', 'Annual Report.pdf', true],
    ['report*.pdf', 'report-final.PDF', true],
    ['report*.pdf', 'old-report.pdf', false],
    ['*name', 'filename', true],
    ['photo-??.jpg', 'photo-01.jpg', true],
    ['photo-??.jpg', 'photo-001.jpg', false],
    ['*.jpg | *.png', 'IMAGE.PNG', true],
    ['*.jpg | *.png', 'image.gif', false],
    ['"report.pdf"', 'old-report.pdf', false],
    ['"report.pdf"', 'REPORT.pdf', true],
    ['[draft]*.txt', '[draft] notes.txt', true],
    ['a*a*a*a*b', 'a'.repeat(240), false],
  ])
    assert.equal(nameMatcher(query)(name), expected, query + ': ' + name);
  assert.equal(nameMatcher('A', 'contains', true)('a.txt'), false);
  assert.equal(nameMatcher('file*', 'contains')('file*.txt'), true);
  assert.equal(nameMatcher('file', 'exact')('file.txt'), false);
  assert.throws(() => nameMatcher('x', 'regex'), /valid/);
});

test('location discovery uses supplied OS paths and pages child folders without files or links', async (t) => {
  const { data } = await setup(t);
  await Promise.all(
    Array.from({ length: 105 }, (_, i) => fs.mkdir(path.join(data, `folder-${i}`))),
  );
  await fs.writeFile(path.join(data, 'file.txt'), 'text');
  await fs.symlink(
    path.join(data, 'folder-0'),
    path.join(data, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const locations = createLocations({
    places: [
      { name: 'Desktop', path: data },
      { name: 'Missing', path: path.join(data, 'absent') },
    ],
    drives: async () => [{ name: 'Volume', path: data }],
  });
  const roots = await locations.roots();
  assert.equal(roots.folders.length, 1);
  assert.equal(roots.folders[0].path, data);
  assert.equal(roots.drives[0].path, data);
  const page = await locations.children(data);
  assert.equal(page.total, 105);
  assert.equal(page.rows.length, 100);
  assert.equal(page.rows[2].name, 'folder-2');
  assert.equal((await locations.children(data, 100)).rows.length, 5);
  await assert.rejects(() => locations.children('relative'), /full folder path/);
  await assert.rejects(() => locations.children(path.join(data, 'absent')), /no longer available/);
  await assert.rejects(() => locations.children(path.join(data, 'link')), /regular folder/);
});

test('search handles whole folders, overlapping scopes, wildcard exclusions and folder results', async (t) => {
  const { data, service } = await setup(t);
  const nested = path.join(data, 'Reports');
  await fs.mkdir(nested);
  await fs.mkdir(path.join(data, 'cache'));
  await fs.writeFile(path.join(data, 'report.pdf'), 'pdf');
  await fs.writeFile(path.join(nested, 'report-02.PDF'), 'pdf2');
  await fs.writeFile(path.join(nested, 'note.txt'), 'note');
  await fs.writeFile(path.join(data, 'cache', 'report.pdf'), 'skip');
  await scan(service, 'search', [data, nested], {
    recursive: true,
    name: 'report*.pdf',
    exclude: 'cache',
  });
  assert.equal(service.query('search').total, 2);
  await service.clear('search');
  await scan(service, 'search', [data], { recursive: true, name: 'report*', kind: 'folders' });
  const folder = service.query('search').rows[0];
  assert.equal(folder.kind, 'folder');
  assert.equal(await service.location('search', folder.id), nested);
  await service.clear('search');
  await scan(service, 'search', [nested, data], { recursive: false, extensions: '*.pdf' });
  assert.equal(service.query('search').total, 2);
  await service.remove('search', nested);
  assert.deepEqual(service.status('search').roots, [data]);
  assert.equal(service.query('search').total, 0);
});

test('search streams results and cancellation preserves usable matches', async (t) => {
  const { data, service } = await setup(t);
  await Promise.all(
    Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(data, `item-${i}.txt`), 'x')),
  );
  await service.select('search', [data]);
  await service.start('search', { recursive: true, name: '*.txt' });
  let observed = false;
  for (let i = 0; i < 1000; i++) {
    const state = service.status('search');
    if (state.count) {
      observed = true;
      assert.ok(service.query('search').rows.length);
      service.cancel('search');
      break;
    }
    if (state.state.phase === 'error') throw Error(JSON.stringify(state.state));
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(observed, true);
  const result = await wait(service, 'search');
  assert.ok(['complete', 'cancelled'].includes(result.state.phase));
  assert.equal((await fs.readdir(data)).length, 300);
});
