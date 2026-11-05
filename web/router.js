(() => {
  if (window.omnia?.isolated) return;
  const names = Object.fromEntries(window.omniaTools.map((tool) => [tool.id, tool.name]));
  const frames = new Map(),
    launcher = document.querySelector('.launcher'),
    footer = document.querySelector('.launcher-footer');
  const failed = new Set();
  const stack = document.createElement('div');
  stack.id = 'tool-stack';
  document.body.append(stack);
  const back = document.createElement('button');
  back.className = 'back-tool shell-back';
  back.hidden = true;
  back.textContent = '←  HUB';
  back.setAttribute('aria-label', 'Back to Hub');
  document.querySelector('.titlebar').prepend(back);
  const notice = document.createElement('div');
  notice.className = 'shell-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  document.body.append(notice);
  let active = 'home',
    changing = false,
    noticeTimer;
  const motion = () =>
    window.omniaSettings?.enabled('transitions') ??
    !matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Background frame fallback.
  function nextFrame() {
    return new Promise((resolve) => {
      let frame, timer;
      const finish = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', changed);
        resolve(performance.now());
      };
      const changed = () => {
        if (document.hidden) finish();
      };
      frame = requestAnimationFrame(finish);
      timer = setTimeout(finish, 250);
      document.addEventListener('visibilitychange', changed);
      if (document.hidden) finish();
    });
  }
  function message(text) {
    clearTimeout(noticeTimer);
    notice.textContent = text;
    notice.hidden = false;
    noticeTimer = setTimeout(() => (notice.hidden = true), 4500);
  }
  function load(tool) {
    if (frames.has(tool)) return frames.get(tool).ready;
    const frame = document.createElement('iframe');
    frame.className = 'tool-frame';
    frame.title = names[tool];
    frame.dataset.tool = tool;
    frame.inert = true;
    frame.tabIndex = -1;
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        frame.remove();
        frames.delete(tool);
        reject(Error('The tool could not load. Try opening it again.'));
      }, 10000);
      frame.addEventListener(
        'load',
        async () => {
          try {
            if (failed.has(tool) || !frame.contentDocument.querySelector('.workspace'))
              throw Error('The tool could not load.');
            await frame.contentDocument.fonts.ready;
            clearTimeout(timeout);
            resolve(frame);
          } catch (error) {
            clearTimeout(timeout);
            frame.remove();
            frames.delete(tool);
            reject(error);
          }
        },
        { once: true },
      );
    });
    frames.set(tool, { frame, ready });
    frame.src = '/' + tool;
    stack.append(frame);
    return ready;
  }
  async function transition(tool) {
    if (changing || tool === active) return;
    if (tool !== 'home' && !names[tool]) return;
    changing = true;
    document.body.dataset.transitioning = 'true';
    document.querySelector('.tool-menu').inert = true;
    back.disabled = true;
    const started = performance.now();
    let incoming, outgoing;
    try {
      incoming = tool === 'home' ? null : await load(tool);
      outgoing = active === 'home' ? null : frames.get(active).frame;
      const requested =
        tool === 'home'
          ? 720
          : Math.min(
              920,
              Math.max(
                760,
                (incoming.contentDocument.querySelector('.native-scroll')?.scrollHeight || 820) +
                  49,
              ),
            );
      launcher.style.visibility = 'visible';
      footer.style.visibility = 'visible';
      document.body.classList.add('page-moving');
      if (incoming) {
        incoming.style.transform = 'translate3d(-100%,0,0)';
        incoming.style.opacity = '.75';
        incoming.style.visibility = 'visible';
        incoming.style.zIndex = '2';
        incoming.inert = false;
        incoming.contentDocument.body.classList.remove('tool-paused');
      }
      if (outgoing) {
        outgoing.style.zIndex = '1';
        outgoing.inert = true;
        outgoing.contentDocument.querySelectorAll('video,audio').forEach((media) => media.pause());
      }
      // Prepare the compositor layer.
      await nextFrame();
      await nextFrame();
      const plan = window.omnia
        ? await window.omnia.resizeStart(requested, !motion())
        : { duration: motion() ? 420 : 0 };
      const duration = plan?.duration ?? 420;
      const samples = [];
      await new Promise((resolve, reject) => {
        let first;
        const tick = async (now) => {
          first ??= now;
          const p = duration && !document.hidden ? Math.min(1, (now - first) / duration) : 1,
            ease = 1 - (1 - p) ** 3;
          samples.push(now);
          if (incoming) {
            incoming.style.transform = `translate3d(${-100 * (1 - ease)}%,0,0)`;
            incoming.style.opacity = String(0.75 + 0.25 * ease);
          }
          if (outgoing) {
            outgoing.style.transform = `translate3d(${tool === 'home' ? -100 * ease : 20 * ease}%,0,0)`;
            outgoing.style.opacity = String(1 - ease * 0.5);
          }
          launcher.style.transform = `translate3d(${tool === 'home' ? 12 * (1 - ease) : 12 * ease}%,0,0)`;
          launcher.style.opacity = String(tool === 'home' ? 0.5 + 0.5 * ease : 1 - 0.5 * ease);
          try {
            if (plan && window.omnia) await window.omnia.resizeFrame(plan.id, p);
            if (p < 1) nextFrame().then(tick);
            else resolve();
          } catch (error) {
            reject(error);
          }
        };
        nextFrame().then(tick);
      });
      if (outgoing) {
        outgoing.style.visibility = 'hidden';
        outgoing.contentDocument.body.classList.add('tool-paused');
      }
      if (incoming) {
        incoming.style.transform = 'none';
        incoming.style.opacity = '1';
        incoming.style.zIndex = '1';
        incoming.focus();
      }
      active = tool;
      document.body.dataset.activeTool = tool;
      if (incoming)
        incoming.contentWindow.dispatchEvent(
          new incoming.contentWindow.Event('omnia:page-visible'),
        );
      launcher.style.transform = '';
      launcher.style.opacity = '';
      launcher.style.visibility = tool === 'home' ? 'visible' : 'hidden';
      footer.style.visibility = tool === 'home' ? 'visible' : 'hidden';
      back.hidden = tool === 'home';
      document.querySelector('.titlebar .wordmark').hidden = tool !== 'home';
      window.omniaRouter.lastTransition = {
        tool,
        loadMs: Math.round((samples[0] || started) - started),
        durationMs: Math.round((samples.at(-1) || started) - (samples[0] || started)),
        maxFrameMs: Math.round(Math.max(0, ...samples.slice(1).map((t, i) => t - samples[i]))),
        frames: samples.length,
      };
    } catch (error) {
      message(error.message);
      if (incoming) {
        incoming.style.visibility = 'hidden';
        incoming.inert = true;
        incoming.contentDocument?.body.classList.add('tool-paused');
      }
      if (outgoing) {
        outgoing.style.visibility = 'visible';
        outgoing.style.transform = 'none';
        outgoing.style.opacity = '1';
        outgoing.inert = false;
        outgoing.contentDocument.body.classList.remove('tool-paused');
      }
      launcher.style.transform = '';
      launcher.style.opacity = '';
      launcher.style.visibility = active === 'home' ? 'visible' : 'hidden';
      footer.style.visibility = active === 'home' ? 'visible' : 'hidden';
    } finally {
      changing = false;
      document.body.classList.remove('page-moving');
      document.body.dataset.transitioning = 'false';
      document.querySelector('.tool-menu').inert = active !== 'home';
      back.disabled = false;
      if (failed.has(active)) void transition('home');
    }
  }
  function quarantine(tool) {
    if (!names[tool] || failed.has(tool)) return;
    failed.add(tool);
    window.omnia?.toolHealth('fault', { id: tool }).catch(() => {});
    const entry = frames.get(tool);
    if (entry) {
      entry.frame.inert = true;
      entry.frame.style.visibility = 'hidden';
    }
    message(names[tool] + ' stopped. Reset it from the directory.');
    if (active === tool && !changing) void transition('home');
  }
  function discard(tool) {
    if (changing || active === tool)
      throw Error('Return to the directory before resetting this tool.');
    frames.get(tool)?.frame.remove();
    frames.delete(tool);
    failed.delete(tool);
  }
  window.omniaRouter = { open: transition, message, quarantine, discard, lastTransition: null };
  document.body.dataset.activeTool = 'home';
  window.omnia?.onNavigate(transition);
  window.omnia?.onNotice(message);
  function requestBack() {
    if (changing || active === 'home') return;
    if (window.omnia) window.omnia.openTool('home').catch((error) => message(error.message));
    else void transition('home');
  }
  window.omnia?.onBack(requestBack);
  back.addEventListener('click', requestBack);
  // Mouse navigation buttons.
  function mouseNavigation(event) {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
      if (event.button === 3 && event.type === 'mouseup') requestBack();
    }
  }
  for (const type of ['mousedown', 'mouseup', 'auxclick'])
    window.addEventListener(type, mouseNavigation, true);
  stack.addEventListener(
    'load',
    (event) => {
      const doc = event.target.contentDocument;
      if (doc)
        for (const type of ['mousedown', 'mouseup', 'auxclick'])
          doc.addEventListener(type, mouseNavigation, true);
    },
    true,
  );
})();
