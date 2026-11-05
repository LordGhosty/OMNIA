const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { createRecovery } = require('../src/recovery.cjs');
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
