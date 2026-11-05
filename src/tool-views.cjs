const path = require('node:path');
const { WebContentsView, screen } = require('electron');

/** Keeps tool renderers outside the directory process, with a bounded clean-page cache. */
function createToolViews({
  window,
  server,
  registry,
  onFault,
  onHome,
  onHistory,
  motionEnabled = () => true,
}) {
  const entries = new Map();
  let active = 'home',
    moving = false,
    covered = false,
    closing = false,
    motion,
    sequence = 0,
    lastTransition;
  const send = (channel, data) => {
    if (!closing && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, data);
  };
  const fit = (entry) => {
    if (closing || window.isDestroyed() || entry.contents.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    entry.view.setBounds({ x: 0, y: 49, width, height: Math.max(1, height - 49) });
  };
  function discard(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (motion?.entry === entry) finishMotion(false);
    entries.delete(id);
    if (!window.isDestroyed()) window.contentView.removeChildView(entry.view);
    if (!entry.contents.isDestroyed()) entry.contents.close();
  }
  function fail(id, reason) {
    if (closing || !entries.has(id)) return;
    onFault(id, reason);
    if (covered && active === id) {
      covered = false;
      send('omnia:settings-dismiss');
    }
    if (motion?.entry.id === id) finishMotion(false);
    discard(id);
    if (active === id) {
      active = 'home';
      send('omnia:navigate', 'home');
      onHome();
    }
  }
  async function load(id) {
    if (entries.has(id)) return entries.get(id);
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        partition: 'omnia-tool-' + id,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const entry = {
      view,
      contents: view.webContents,
      id,
      beat: Date.now(),
      dirty: false,
      touched: Date.now(),
    };
    entries.set(id, entry);
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    window.contentView.addChildView(view);
    fit(entry);
    const wc = view.webContents;
    wc.session.setPermissionRequestHandler((_wc, _p, reply) => reply(false));
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('will-frame-navigate', (event) => {
      if (event.url && !event.url.startsWith(server.origin + '/')) event.preventDefault();
    });
    wc.on('render-process-gone', () => fail(id, 'The tool interface stopped.'));
    wc.on('unresponsive', () => fail(id, 'The tool interface stopped responding.'));
    wc.on('before-input-event', (event, input) => {
      const back = input.key === 'BrowserBack' || (input.alt && input.key === 'ArrowLeft');
      const forward = input.key === 'BrowserForward' || (input.alt && input.key === 'ArrowRight');
      if (back || forward) {
        event.preventDefault();
        if (input.type === 'keyDown' && !input.isAutoRepeat) onHistory(back ? 'back' : 'forward');
      }
    });
    let timeout;
    try {
      await Promise.race([
        wc.loadURL(server.toolURL(id)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('The tool interface could not load.')), 15000);
        }),
      ]);
    } catch (error) {
      fail(id, error.message);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    return entry;
  }
  function finishMotion(ok = true) {
    if (!motion) return;
    const current = motion;
    motion = null;
    clearTimeout(current.timeout);
    current.resolve(ok);
  }
  function frame(sender, id, progress) {
    const current = motion;
    if (
      closing ||
      window.isDestroyed() ||
      !current ||
      current.id !== id ||
      sender !== current.entry.contents ||
      !Number.isFinite(progress)
    )
      return;
    const p = Math.min(1, Math.max(current.progress, progress));
    current.progress = p;
    if (current.frames.length < 4096) current.frames.push(performance.now());
    const ease = 1 - (1 - p) ** 3;
    if (!window.isMaximized() && !window.isFullScreen()) {
      const height = Math.round(
        current.from.height + (current.to.height - current.from.height) * ease,
      );
      const y = Math.round(current.from.y + (current.to.y - current.from.y) * ease);
      if (height !== current.last.height || y !== current.last.y) {
        window.setBounds({ height, y });
        current.last = { height, y };
        current.updates++;
      }
    }
    if (p === 1) {
      lastTransition = {
        tool: current.tool,
        loadMs: current.loadMs,
        durationMs: Math.round(current.frames.at(-1) - current.frames[0]),
        frames: current.frames.length,
        maxFrameMs: Math.round(
          Math.max(0, ...current.frames.slice(1).map((t, i) => t - current.frames[i])),
        ),
        boundsUpdates: current.updates,
        displayHz: screen.getDisplayMatching(window.getBounds()).displayFrequency,
      };
      finishMotion();
    }
  }
  async function animate(entry, tool, leaving, reduced, loadMs) {
    const from = window.getBounds(),
      work = screen.getDisplayMatching(from).workArea;
    const height = Math.min(tool === 'home' ? 720 : 920, work.height - 30);
    const to = { height, y: Math.max(work.y, Math.min(from.y, work.y + work.height - height)) };
    return new Promise((resolve) => {
      const id = ++sequence;
      motion = {
        id,
        entry,
        tool,
        from,
        to,
        last: from,
        progress: 0,
        frames: [],
        updates: 0,
        loadMs,
        resolve,
      };
      motion.timeout = setTimeout(() => {
        if (window.isMinimized() || !window.isVisible()) frame(entry.contents, id, 1);
        else fail(entry.id, 'The tool transition stopped responding.');
      }, 5000);
      entry.contents.send('omnia:motion', { id, leaving, duration: reduced ? 0 : 420 });
    });
  }
  async function open(id) {
    if (closing || window.isDestroyed() || moving || covered) return false;
    if (id === active) return true;
    moving = true;
    send('omnia:tool-transition', { tool: id, moving: true });
    const started = performance.now();
    try {
      const incoming = id === 'home' ? null : await load(id),
        outgoing = entries.get(active);
      const driver = incoming || outgoing;
      if (closing || window.isDestroyed() || driver?.contents.isDestroyed()) return false;
      if (!driver) return true;
      const reduced = await driver.contents.executeJavaScript(`(async()=>{
        await window.omniaSettings?.ready;
        const content=document.querySelector('.native-scroll');
        content.style.background='var(--bg)';content.style.willChange='transform';
        content.style.transform=${incoming ? "'translate3d(-100%,0,0)'" : "'none'"};
        document.body.style.background='transparent';
        document.body.classList.remove('tool-paused');
        return matchMedia('(prefers-reduced-motion: reduce)').matches;
      })()`);
      if (closing || window.isDestroyed() || driver.contents.isDestroyed()) return false;
      if (incoming) {
        incoming.touched = Date.now();
        fit(incoming);
        window.contentView.removeChildView(incoming.view);
        window.contentView.addChildView(incoming.view);
        incoming.view.setVisible(true);
      }
      if (outgoing)
        void outgoing.contents
          .executeJavaScript("document.querySelectorAll('video,audio').forEach(e=>e.pause())")
          .catch(() => {});
      const completed = await animate(
        driver,
        id,
        !incoming,
        reduced || !motionEnabled(),
        Math.round(performance.now() - started),
      );
      if (!completed || closing || window.isDestroyed()) return false;
      if (outgoing && outgoing !== incoming) {
        outgoing.contents.send('omnia:settings-dismiss');
        outgoing.view.setVisible(false);
        void outgoing.contents
          .executeJavaScript("document.body.classList.add('tool-paused')")
          .catch(() => {});
      }
      active = id;
      if (incoming && !incoming.contents.isDestroyed()) {
        fit(incoming);
        incoming.contents.send('omnia:tool-visible');
        incoming.contents.focus();
      }
      const clean = [...entries.values()]
        .filter((e) => e.id !== active && !e.dirty)
        .sort((a, b) => b.touched - a.touched);
      for (const entry of clean.slice(2)) discard(entry.id);
      send('omnia:navigate', id);
      return true;
    } catch (error) {
      if (closing || window.isDestroyed()) return false;
      throw error;
    } finally {
      moving = false;
      send('omnia:tool-transition', { tool: active, moving: false });
    }
  }
  window.on('resize', () => {
    const current = entries.get(active);
    if (current) fit(current);
    if (motion?.entry !== current && motion?.entry) fit(motion.entry);
  });
  const watchdog = setInterval(() => {
    for (const entry of entries.values())
      if (Date.now() - entry.beat > 12000) fail(entry.id, 'The tool interface stopped responding.');
  }, 2000);
  watchdog.unref();
  return {
    open,
    discard,
    fail,
    get: (id) => entries.get(id)?.contents,
    active: () => active,
    covered: () => covered,
    async backdrop() {
      if (closing || moving || window.isDestroyed()) return null;
      const id = active,
        entry = entries.get(id);
      const image = entry ? (await entry.contents.capturePage()).toDataURL() : null;
      return !closing && !moving && active === id ? { id, image } : null;
    },
    cover(id) {
      if (closing || moving || active !== id || window.isDestroyed()) return false;
      covered = true;
      const entry = entries.get(active);
      if (entry) {
        entry.view.setVisible(false);
        void entry.contents
          .executeJavaScript("document.body.classList.add('tool-paused')")
          .catch(() => {});
      }
      window.webContents.focus();
      return true;
    },
    uncover() {
      if (!covered || closing || window.isDestroyed()) return;
      covered = false;
      const entry = entries.get(active);
      if (entry && !entry.contents.isDestroyed()) {
        entry.view.setVisible(true);
        void entry.contents
          .executeJavaScript("document.body.classList.remove('tool-paused')")
          .catch(() => {});
        entry.contents.focus();
      }
    },
    frame,
    lastTransition: () => lastTransition,
    home() {
      if (closing || window.isDestroyed()) return;
      finishMotion(false);
      if (covered) send('omnia:settings-dismiss');
      covered = false;
      onHome();
      for (const entry of entries.values()) entry.view.setVisible(false);
      active = 'home';
    },
    identify: (wc) => [...entries.values()].find((e) => e.contents === wc)?.id,
    heartbeat(wc, dirty) {
      const entry = [...entries.values()].find((e) => e.contents === wc);
      if (entry) {
        entry.beat = Date.now();
        if (typeof dirty === 'boolean') entry.dirty = dirty;
      }
    },
    broadcast(channel, data) {
      if (closing) return;
      send(channel, data);
      for (const entry of entries.values())
        if (!entry.contents.isDestroyed()) entry.contents.send(channel, data);
    },
    close() {
      if (closing) return;
      closing = true;
      finishMotion(false);
      clearInterval(watchdog);
      for (const id of [...entries.keys()]) discard(id);
    },
  };
}
module.exports = { createToolViews };
