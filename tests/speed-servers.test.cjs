const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalog, publicLookup } = require('../src/speed-servers.cjs');
test('speed catalogue accepts public HTTPS entries and rejects unsafe endpoint changes', () => {
  const good = {
    id: 12,
    name: 'Example',
    server: 'https://speed.example.com/backend',
    dlURL: 'garbage.php',
    ulURL: 'empty.php',
    pingURL: 'empty.php',
  };
  const list = parseCatalog([
    good,
    { ...good, id: 13, server: 'http://example.com' },
    { ...good, id: 14, server: 'https://127.0.0.1' },
    { ...good, id: 15, dlURL: 'https://evil.example.com/test' },
    { ...good, id: 16, server: 'https://user:pass@example.com' },
  ]);
  assert.deepEqual(Object.keys(list), ['ls-12']);
  assert.equal(list['ls-12'].download, 'https://speed.example.com/backend/garbage.php');
});
test('speed server DNS refuses loopback destinations', async () => {
  await assert.rejects(
    new Promise((resolve, reject) =>
      publicLookup('localhost', { all: true }, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    ),
    /public network/,
  );
});
