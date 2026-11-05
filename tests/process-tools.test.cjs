const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork, execFileSync } = require('node:child_process');
const { createProcessService } = require('../src/process-host.cjs');
const { createToolGroup } = require('../src/tool-group.cjs');
const { startServer, binaries } = require('../src/server.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function service(kind, root, tool) {
  return createProcessService({
    kind,
    options: { userData: root, tool },
    guard:
      process.platform === 'win32'
        ? (pid, onExit) =>
            require('../src/process-guard.cjs').guardProcess(
              path.join(__dirname, '../vendor/win32/omnia-process-guard.exe'),
              pid,
              { onExit },
            )
        : undefined,
    fork: (file) => {
      const child = fork(file, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      child.postMessage = (message) => child.send(message);
      return child;
    },
  });
}
async function done(read, active) {
  for (let i = 0; i < 600; i++) {
    const value = await read();
    if (!active(value)) return value;
    await delay(50);
  }
  throw Error('Fixture operation timed out.');
}
test('image and metadata results survive RPC routing and save to new files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-process-images-'));
  const images = service('workbench', root, 'images'),
    metadata = service('workbench', root, 'metadata');
  const group = createToolGroup(
    { images, metadata },
    {
      select: 'tool',
      start: 'tool',
      status: 'owner',
      asset: 'owner',
      save: 'owner',
      clear: 'tool',
    },
  );
  t.after(async () => {
    await Promise.all([images.close(), metadata.close()]);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source.png');
  await fs.copyFile(path.join(__dirname, '../assets/app-icon.png'), source);
  const original = await fs.readFile(source);
  await group.select('images', [source]);
  await group.select('metadata', [source]);
  const imageJob = await group.start('images', 'convert', {
    format: 'webp',
    width: 64,
    quality: 90,
    strip: true,
  });
  const metaJob = await group.start('metadata', 'metadata-write', {
    fields: { notes: 'Fixture note', title: '', author: '', copyright: '' },
  });
  const image = await done(
    () => group.status(imageJob.id),
    (v) => ['running', 'cancelling'].includes(v.state),
  );
  const meta = await done(
    () => group.status(metaJob.id),
    (v) => ['running', 'cancelling'].includes(v.state),
  );
  assert.equal(image.state, 'done');
  assert.equal(meta.state, 'done');
  assert.equal(image.results[0].outputInfo.width, 64);
  assert.equal(meta.results[0].fields.notes, 'Fixture note');
  const copy = path.join(root, 'notes.png');
  await group.save(meta.results[0].output, copy);
  await group.clear('metadata');
  await group.select('metadata', [copy]);
  const read = await group.start('metadata', 'metadata-read', {});
  const result = await done(
    () => group.status(read.id),
    (v) => ['running', 'cancelling'].includes(v.state),
  );
  assert.equal(result.results[0].fields.notes, 'Fixture note');
  assert.notEqual(images.pid, metadata.pid);
  assert.deepEqual(await fs.readFile(source), original);
});
test('file rename plans route to their owning process and remain undoable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-process-files-'));
  const rename = service('files', root, 'rename'),
    search = service('files', root, 'search');
  t.after(async () => {
    await Promise.all([rename.close(), search.close()]);
    await fs.rm(root, { recursive: true, force: true });
  });
  const group = createToolGroup(
    { rename, search },
    {
      select: 'tool',
      start: 'tool',
      status: 'tool',
      query: 'tool',
      prepareRename: 'rename',
      prepareUndo: 'rename',
      execute: 'owner',
      history: 'rename',
    },
  );
  const source = path.join(root, 'source.txt');
  await fs.writeFile(source, 'Fixture');
  for (const id of ['rename', 'search']) {
    await group.select(id, [source]);
    await group.start(id, {});
    await done(
      () => group.status(id),
      (v) => ['scanning', 'comparing'].includes(v.state.phase),
    );
  }
  assert.equal((await group.query('search')).rows.length, 1);
  const plan = await group.prepareRename({ prefix: 'new-' });
  await group.execute(plan.token);
  assert.equal(await fs.readFile(path.join(root, 'new-source.txt'), 'utf8'), 'Fixture');
  const history = await group.history();
  const undo = await group.prepareUndo(history[0].id);
  await group.execute(undo.token);
  assert.equal(await fs.readFile(source, 'utf8'), 'Fixture');
  assert.notEqual(rename.pid, search.pid);
});
test('media proxy routes separate converter sessions without leaking job identities', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-process-media-'));
  const services = Object.fromEntries(
    ['mp3', 'mp4', 'gif'].map((id) => [id, service('media', root, id)]),
  );
  const core = await startServer({ remoteMedia: createToolGroup(services, {}) });
  t.after(async () => {
    await core.close();
    await Promise.all(Object.values(services).map((s) => s.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source.mp4');
  execFileSync(
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=80x60:rate=10:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      '-shortest',
      source,
    ],
    { windowsHide: true },
  );
  const cookies = {},
    ids = {};
  for (const tool of ['mp3', 'mp4', 'gif']) {
    const auth = await fetch(core.toolURL(tool), { redirect: 'manual' });
    cookies[tool] = auth.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    const response = await fetch(
      core.origin + '/api/jobs?name=source.mp4&format=' + tool + '&bitrate=192&duration=0.8',
      {
        method: 'POST',
        headers: { Cookie: cookies[tool], 'X-Omnia': '1' },
        body: await fs.readFile(source),
      },
    );
    assert.equal(response.status, 202, await response.clone().text());
    ids[tool] = (await response.json()).id;
    const result = await done(
      async () =>
        (
          await fetch(core.origin + '/api/jobs/' + ids[tool], {
            headers: { Cookie: cookies[tool] },
          })
        ).json(),
      (v) => !['done', 'ready', 'error'].includes(v.state),
    );
    assert.notEqual(result.state, 'error', result.error);
  }
  assert.equal(new Set(Object.values(services).map((s) => s.pid)).size, 3);
  const other = await fetch(core.origin + '/api/jobs/' + ids.mp3, {
    headers: { Cookie: cookies.gif },
  });
  assert.equal(other.status, 404);
});
