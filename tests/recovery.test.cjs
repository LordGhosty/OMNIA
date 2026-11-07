const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { createRecovery } = require('../src/recovery.cjs');
test('startup recovery offers only installed utilities and keeps the exit action correct', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/bootstrap.cjs'), 'utf8');
  for (const installed of [false, true]) {
    for (const action of ['start', 'exit', ...(installed ? ['recovery'] : [])]) {
      let prompt,
        quit = false,
        opened = false,
        started = false;
      const app = {
        requestSingleInstanceLock: () => true,
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.2',
        whenReady: async () => {},
        quit: () => {
          quit = true;
        },
      };
      const dialog = {
        showMessageBox: async (options) => {
          prompt = options;
          return { response: action === 'start' ? 0 : action === 'exit' ? options.cancelId : 1 };
        },
        showErrorBox: () => assert.fail('Unexpected recovery error'),
      };
      require('node:vm').runInNewContext(source, {
        process: { platform: 'win32', execPath: process.execPath, env: {} },
        module: { exports: {} },
        require(name) {
          if (name === 'electron')
            return {
              app,
              dialog,
              shell: {
                openPath: async () => {
                  opened = true;
                  return '';
                },
              },
            };
          if (name === 'node:path') return path;
          if (name === 'node:fs') return { existsSync: () => installed };
          if (name === './recovery.cjs')
            return {
              createRecovery: () => ({ begin: async () => ({ attempts: 3 }) }),
              writeJSON: async () => {},
            };
          if (name === './main.cjs') {
            started = true;
            return {};
          }
          if (name.endsWith('/tools.json')) return [];
          if (name.endsWith('.json')) return {};
          throw Error('Unexpected module ' + name);
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(prompt.buttons.includes('Open recovery'), installed);
      assert.equal(prompt.buttons[prompt.cancelId], 'Exit');
      assert.equal(started, action === 'start');
      assert.equal(quit, action !== 'start');
      assert.equal(opened, action === 'recovery');
    }
  }
});

test('recovery counts unfinished starts and resets the count only after readiness', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recovery = createRecovery({
    directory,
    version: '1.0.0',
    buildId: 'fixture',
    verify: async () => {},
  });
  assert.equal((await recovery.begin()).attempts, 1);
  assert.equal((await recovery.begin()).attempts, 2);
  assert.equal((await recovery.begin()).attempts, 3);
  await recovery.healthy();
  assert.equal((await recovery.begin()).attempts, 1);
});
test('update recovery caches only the exact stable version after publisher verification', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let downloads = 0,
    verified = 0,
    reject = false;
  const config = {
    directory,
    version: '1.0.0',
    buildId: 'fixture',
    repository: 'example/omnia',
    verify: async (file) => {
      verified++;
      assert.equal(await fs.readFile(file, 'utf8'), 'fixture installer');
      if (reject) throw Error('Untrusted publisher');
    },
    fetcher: async (url) => {
      if (url.includes('api.github.com'))
        return new Response(
          JSON.stringify({
            tag_name: 'v1.0.0',
            assets: [
              {
                name: 'OMNIA-1.0.0-Setup.exe',
                browser_download_url:
                  'https://github.com/example/omnia/releases/download/v1.0.0/OMNIA-1.0.0-Setup.exe',
              },
            ],
          }),
        );
      downloads++;
      return new Response('fixture installer');
    },
  };
  const recovery = createRecovery(config);
  assert.equal((await recovery.prepare()).version, '1.0.0');
  await recovery.prepare();
  assert.equal(downloads, 1);
  assert.ok(verified >= 2);
  await fs.appendFile(path.join(directory, 'previous-setup.exe'), 'changed');
  assert.equal(await recovery.backup(), null);
  reject = true;
  await assert.rejects(recovery.prepare(), /publisher/);
  assert.equal((await fs.readdir(directory)).filter((file) => file.endsWith('.partial')).length, 0);
});
test('wrong tags, drafts and unexpected asset URLs cannot become recovery installers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recovery = createRecovery({
    directory,
    version: '1.0.0',
    buildId: 'fixture',
    repository: 'example/omnia',
    verify: async () => {},
    fetcher: async () => new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: [] })),
  });
  await assert.rejects(recovery.prepare(), /matching stable/);
});
