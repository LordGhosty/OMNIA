const test = require('node:test'),
  assert = require('node:assert/strict');
const { windowsTarget } = require('../src/platform.cjs');
test('Windows desktop target includes Windows 10 22H2 and Windows 11 x64', () => {
  for (const release of ['10.0.19045', '10.0.22000', '10.0.22631', '10.0.26100'])
    assert.equal(windowsTarget(release, 'x64', 'win32').target, true);
  for (const release of ['6.1.7601', '6.3.9600', '10.0.18363', 'invalid'])
    assert.equal(windowsTarget(release, 'x64', 'win32').target, false);
  assert.equal(windowsTarget('10.0.19045', 'arm64', 'win32').target, false);
  assert.equal(windowsTarget('10.0.19045', 'x64', 'linux').target, false);
});
