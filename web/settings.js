(() => {
  const defaults = {
    enabled: true,
    insignia: true,
    transitions: true,
    details: true,
    windowResize: true,
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let state = { ...defaults },
    saving = false,
    overlay = false,
    drag,
    closeTimer,
    openFrame;
  const panel = document.createElement('dialog');
  panel.id = 'settings-panel';
  panel.setAttribute('aria-labelledby', 'settings-title');
  panel.innerHTML = `<header class="settings-heading"><h2 id="settings-title">Settings</h2></header>
    <div class="settings-body"><label class="settings-row settings-master"><span>Omnia Animations</span><input type="checkbox" role="switch" data-setting="enabled"><span class="settings-switch" aria-hidden="true"></span></label>
    <div class="settings-options"><div>
      <label class="settings-row"><span>Insignia animations</span><input type="checkbox" role="switch" data-setting="insignia"><span class="settings-switch" aria-hidden="true"></span></label>
      <label class="settings-row"><span>Tool Transition</span><input type="checkbox" role="switch" data-setting="transitions"><span class="settings-switch" aria-hidden="true"></span></label>
      <label class="settings-row"><span>Detail Animations</span><input type="checkbox" role="switch" data-setting="details"><span class="settings-switch" aria-hidden="true"></span></label>
    </div></div><label class="settings-row settings-master" title="Adjust window height when entering or leaving a tool"><span>Window Resize</span><input type="checkbox" role="switch" data-setting="windowResize"><span class="settings-switch" aria-hidden="true"></span></label><p class="settings-note" id="settings-reduced" hidden>Reduced motion is enabled in your system settings.</p><p id="settings-status" class="settings-note" role="status"></p></div>`;
  document.body.append(panel);
  const snapshot = document.createElement('img');
  snapshot.className = 'settings-snapshot';
  snapshot.alt = '';
  snapshot.hidden = true;
  document.body.append(snapshot);
  const options = panel.querySelector('.settings-options');
  const controls = [...panel.querySelectorAll('[data-setting]')];
  const status = panel.querySelector('#settings-status');
  const enabled = (kind) => state.enabled && !reduce.matches && (kind ? state[kind] : true);
  function apply(next) {
    state = { ...defaults, ...next };
    root.dataset.animations = enabled() ? 'on' : 'off';
    root.dataset.insigniaMotion = enabled('insignia') ? 'on' : 'off';
    root.dataset.toolMotion = enabled('transitions') ? 'on' : 'off';
    root.dataset.detailMotion = enabled('details') ? 'on' : 'off';
    panel.classList.toggle('settings-enabled', state.enabled);
    options.inert = !state.enabled;
    options.setAttribute('aria-hidden', String(!state.enabled));
    for (const control of controls) control.checked = state[control.dataset.setting];
    panel.querySelector('#settings-reduced').hidden = !reduce.matches;
    if (!enabled()) {
      for (const animation of document.getAnimations()) {
        try {
          animation.finish();
        } catch {
          animation.cancel();
        }
      }
      if (closeTimer) close(true);
    }
    window.dispatchEvent(new CustomEvent('omnia:settings-changed', { detail: { ...state } }));
  }
  function close(immediate = false) {
    cancelDrag();
    cancelAnimationFrame(openFrame);
    clearTimeout(closeTimer);
    closeTimer = null;
    panel.classList.remove('settings-visible');
    document.body.classList.remove('settings-open');
    const finish = async () => {
      closeTimer = null;
      panel.close();
      if (overlay) {
        overlay = false;
        try {
          await window.omnia.settings('uncover');
        } catch {}
      }
      snapshot.hidden = true;
      snapshot.removeAttribute('src');
    };
    if (immediate || !enabled()) finish();
    else closeTimer = setTimeout(finish, 260);
  }
  async function open(data) {
    if (panel.open && !closeTimer) return close();
    clearTimeout(closeTimer);
    closeTimer = null;
    if (data && window.omnia?.settings) {
      if (data.image) {
        snapshot.src = data.image;
        await snapshot.decode();
      }
      overlay = await window.omnia.settings('cover');
      if (!overlay) {
        snapshot.removeAttribute('src');
        if (button) button.disabled = false;
        return;
      }
      snapshot.hidden = !data.image;
    }
    if (!panel.open) panel.showModal();
    document.body.classList.add('settings-open');
    panel.getBoundingClientRect();
    openFrame = requestAnimationFrame(() => panel.classList.add('settings-visible'));
    if (button) button.disabled = false;
  }
  panel.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  panel.addEventListener('click', (event) => {
    if (event.target !== panel) return;
    const rect = panel.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      close();
  });
  panel.addEventListener('change', async (event) => {
    const key = event.target.dataset.setting;
    if (!Object.hasOwn(defaults, key) || saving) return;
    const previous = { ...state },
      patch = { [key]: event.target.checked };
    const focused = document.activeElement === event.target;
    saving = true;
    for (const input of controls) input.disabled = true;
    status.textContent = '';
    apply({ ...state, ...patch });
    try {
      if (window.omnia?.settings) apply(await window.omnia.settings('update', patch));
      else localStorage.setItem('omnia-animations', JSON.stringify(state));
    } catch {
      apply(previous);
      status.textContent = 'Could not save settings. Try again.';
    } finally {
      saving = false;
      for (const input of controls) input.disabled = false;
      if (focused && panel.open) event.target.focus({ preventScroll: true });
    }
  });
  function cancelDrag() {
    if (!drag) return;
    const { track, pointer } = drag;
    drag = null;
    track.classList.remove('switch-pressed', 'switch-dragging');
    track.style.removeProperty('--switch-position');
    if (track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
  }
  for (const track of panel.querySelectorAll('.settings-switch')) {
    const input = track.previousElementSibling;
    track.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || input.disabled || drag) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      drag = {
        track,
        input,
        pointer: event.pointerId,
        start: event.clientX,
        initial: input.checked ? 1 : 0,
        value: input.checked ? 1 : 0,
        moved: false,
      };
      track.setPointerCapture(event.pointerId);
      track.style.setProperty('--switch-position', drag.value * 16 + 'px');
      track.classList.add('switch-pressed');
    });
    track.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointer !== event.pointerId || drag.track !== track) return;
      const distance = event.clientX - drag.start;
      drag.moved ||= Math.abs(distance) >= 3;
      if (!drag.moved) return;
      drag.value = Math.max(0, Math.min(1, drag.initial + distance / 16));
      track.classList.add('switch-dragging');
      track.style.setProperty('--switch-position', drag.value * 16 + 'px');
    });
    track.addEventListener('pointerup', (event) => {
      if (!drag || drag.pointer !== event.pointerId || drag.track !== track) return;
      const checked = drag.moved ? drag.value >= 0.5 : !input.checked;
      cancelDrag();
      if (checked !== input.checked) {
        input.checked = checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    track.addEventListener('pointercancel', cancelDrag);
    track.addEventListener('lostpointercapture', cancelDrag);
    track.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  window.addEventListener('blur', cancelDrag);
  reduce.addEventListener('change', () => apply(state));
  window.addEventListener('omnia:settings-dismiss', () => close(true));
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('animations-hidden', document.hidden);
    if (document.hidden && panel.open) close(true);
  });
  window.omnia?.onSettings?.(apply);
  window.omnia?.onSettingsOpen?.((data) =>
    open(data).catch(() => {
      close(true);
      if (button) button.disabled = false;
      window.omniaRouter?.message('Settings could not be opened.');
    }),
  );
  if (!window.omnia?.settings)
    window.addEventListener('storage', (event) => {
      if (event.key === 'omnia-animations') {
        try {
          apply(JSON.parse(event.newValue) || defaults);
        } catch {}
      }
    });
  const ready = (async () => {
    try {
      const stored = window.omnia?.settings
        ? await window.omnia.settings('get')
        : JSON.parse(localStorage.getItem('omnia-animations') || 'null');
      const next = { ...defaults };
      for (const key of Object.keys(defaults))
        if (typeof stored?.[key] === 'boolean') next[key] = stored[key];
      apply(next);
    } catch {
      apply(defaults);
      status.textContent = 'Saved settings could not be loaded.';
    }
  })();
  window.omniaSettings = { ready, enabled, open, close };
  const button = document.querySelector('#settings');
  button?.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (window.omnia?.settings) {
        if (!(await window.omnia.settings('open'))) button.disabled = false;
      } else await open();
    } catch {
      button.disabled = false;
      window.omniaRouter?.message('Settings could not be opened.');
    }
  });
})();
