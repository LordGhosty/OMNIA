const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { guardProcess } = require('../src/process-guard.cjs');
const helper = path.join(__dirname, '../vendor/win32/omnia-process-guard.exe');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function fixture() {
  return fork(path.join(__dirname, 'fixtures/process-tree.cjs'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
}
async function dead(pid) {
  for (let n = 0; n < 100 && alive(pid); n++) await delay(50);
  assert.equal(alive(pid), false, 'Process should exit: ' + pid);
}
for (const ending of ['backend', 'guard', 'parent'])
  test(
    'Windows containment ends descendants when ' + ending + ' exits',
    { skip: process.platform !== 'win32', timeout: 20000 },
    async (t) => {
      const child = fixture(),
        parent = ending === 'parent' ? fixture() : null;
      let guard, descendant;
      t.after(() => {
        guard?.close();
        child.kill();
        parent?.kill();
        if (descendant && alive(descendant)) process.kill(descendant);
      });
      await once(child, 'message');
      guard = await guardProcess(helper, child.pid, {
        parent: parent?.pid || process.pid,
        memoryMB: 256,
      });
      const next = once(child, 'message');
      child.send('spawn');
      [descendant] = await next;
      assert.equal(alive(descendant), true);
      if (ending === 'backend') child.kill();
      else if (ending === 'parent') parent.kill();
      else guard.close();
      await dead(child.pid);
      await dead(descendant);
    },
  );
test(
  'Windows containment rejects missing backend',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(guardProcess(helper, 2147483647), /could not contain/);
  },
);

test(
  'Windows job refuses allocation beyond its memory ceiling',
  { skip: process.platform !== 'win32', timeout: 20000 },
  async (t) => {
    const child = fixture();
    let guard;
    t.after(() => {
      guard?.close();
      child.kill();
    });
    await once(child, 'message');
    guard = await guardProcess(helper, child.pid, { memoryMB: 256 });
    const outcome = new Promise((resolve) => {
      child.once('exit', () => resolve('exited'));
      child.once('message', resolve);
    });
    child.send('allocate');
    assert.notEqual(await outcome, 'allocated');
  },
);
