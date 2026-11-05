const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(t, { animate = true, loading = false } = {}) {
  let host, finishLoad;
  const faults = [],
    children = [],
    contents = [];
  class Contents extends EventEmitter {
    constructor() {
      super();
      this.dead = false;
      this.closed = 0;
      this.session = { setPermissionRequestHandler() {} };
      contents.push(this);
    }
    isDestroyed() {
      return this.dead;
    }
    close() {
      assert.equal(this.dead, false, 'closed destroyed contents');
      this.closed++;
      this.dead = true;
    }
    setWindowOpenHandler() {}
    loadURL() {
      return loading
        ? new Promise((resolve) => {
            finishLoad = resolve;
          })
        : Promise.resolve();
    }
    executeJavaScript() {
      assert.equal(this.dead, false);
      return Promise.resolve(false);
    }
    send(channel, plan) {
      assert.equal(this.dead, false, 'sent to destroyed contents');
      if (channel === 'omnia:motion' && animate) queueMicrotask(() => host.frame(this, plan.id, 1));
    }
    focus() {
      assert.equal(this.dead, false);
    }
  }
  class View {
    constructor() {
      this.webContents = new Contents();
    }
    setBackgroundColor() {}
    setVisible() {}
    setBounds() {}
  }
  const window = new EventEmitter();
  window.dead = false;
  window.webContents = new Contents();
  window.isDestroyed = () => window.dead;
  Object.defineProperty(window, 'contentView', {
    get() {
      assert.equal(window.dead, false, 'accessed destroyed window');
      return {
        addChildView(view) {
          children.push(view);
        },
        removeChildView(view) {
          const index = children.indexOf(view);
          if (index >= 0) children.splice(index, 1);
        },
      };
    },
  });
  window.getContentSize = () => [1080, 720];
  window.getBounds = () => ({ x: 0, y: 0, width: 1080, height: 720 });
  window.setBounds = () => assert.equal(window.dead, false);
  window.isMaximized = window.isFullScreen = window.isMinimized = () => false;
  window.isVisible = () => true;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/tool-views.cjs'), 'utf8'), {
    require: (name) =>
      name === 'electron'
        ? {
            WebContentsView: View,
            screen: {
              getDisplayMatching: () => ({
                workArea: { x: 0, y: 0, height: 1080 },
                displayFrequency: 60,
              }),
            },
          }
        : require(name),
    __dirname: path.join(__dirname, '../src'),
    module,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  host = module.exports.createToolViews({
    window,
    server: { origin: 'http://localhost', toolURL: (id) => 'http://localhost/' + id },
    registry: [],
    onFault: (...args) => faults.push(args),
    onHome() {},
    onHistory() {},
  });
  t.after(() => host.close());
  return { host, window, contents, children, faults, finishLoad: () => finishLoad() };
}

test('closing cached and active views is idempotent', async (t) => {
  const f = fixture(t);
  await f.host.open('mp3');
  await f.host.open('home');
  await f.host.open('mp4');
  f.host.close();
  f.host.close();
  assert.equal(f.children.length, 0);
  assert.ok(f.contents.slice(1).every((wc) => wc.closed === 1));
  assert.equal(await f.host.open('gif'), false);
  assert.equal(f.faults.length, 0);
});
test('cleanup tolerates an already destroyed window and tool contents', async (t) => {
  const f = fixture(t);
  await f.host.open('mp3');
  f.host.get('mp3').close();
  f.window.dead = true;
  f.window.webContents.dead = true;
  assert.doesNotThrow(() => f.host.close());
  assert.doesNotThrow(() => f.host.broadcast('late', {}));
  assert.doesNotThrow(() => f.host.discard('mp3'));
  assert.equal(f.faults.length, 0);
});
test('closing during a transition cancels pending work without quarantining the tool', async (t) => {
  const f = fixture(t, { animate: false });
  const opening = f.host.open('mp3');
  await new Promise((resolve) => setImmediate(resolve));
  f.host.close();
  f.window.dead = true;
  assert.equal(await opening, false);
  assert.doesNotThrow(() => f.host.frame(f.contents[1], 1, 1));
  assert.equal(f.faults.length, 0);
});
test('closing during page loading prevents late renderer access', async (t) => {
  const f = fixture(t, { loading: true });
  const opening = f.host.open('mp3');
  f.host.close();
  f.window.dead = true;
  f.finishLoad();
  assert.equal(await opening, false);
  assert.equal(f.faults.length, 0);
});
