(() => {
  const feedback = new WeakMap();
  function clearInput(field) {
    const state = feedback.get(field);
    if (!state) return;
    state.animation?.cancel();
    state.note.hidden = true;
    state.note.textContent = '';
    field.removeAttribute('aria-invalid');
  }
  function rejectInput(field, text) {
    if (!field) return;
    let state = feedback.get(field);
    if (!state) {
      const note = document.createElement('p');
      note.id = field.id + '-feedback';
      note.className = 'input-feedback';
      note.setAttribute('role', 'alert');
      field.after(note);
      field.setAttribute(
        'aria-describedby',
        [field.getAttribute('aria-describedby'), note.id].filter(Boolean).join(' '),
      );
      state = { note };
      feedback.set(field, state);
    }
    clearInput(field);
    state.note.hidden = false;
    state.note.textContent = text;
    field.setAttribute('aria-invalid', 'true');
    state.note.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    if (window.omniaSettings?.enabled() ?? !matchMedia('(prefers-reduced-motion: reduce)').matches)
      state.animation = field.animate(
        [0, -5, 5, -3, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
        { duration: 260, easing: 'ease-out' },
      );
  }
  window.omniaFeedback = {
    clear: clearInput,
    reject: rejectInput,
    async check(field, read) {
      try {
        const result = await read();
        clearInput(field);
        return result;
      } catch (error) {
        rejectInput(field, error.message);
        throw error;
      }
    },
  };
  const home = document.querySelector('[aria-label="OMNIA home"]');
  const embedded =
    window.parent !== window &&
    window.parent.location.origin === location.origin &&
    window.parent.omniaRouter;
  if (embedded && window.parent.omnia) window.omnia = window.parent.omnia;
  if (embedded || window.omnia?.isolated) {
    const quarantine = () =>
      window.omnia?.isolated
        ? window.omnia.toolHealth('fault', { id: document.body.dataset.tool }).catch(() => {})
        : window.parent.omniaRouter.quarantine(document.body.dataset.tool);
    window.addEventListener(
      'error',
      (event) => {
        if (event.message || event.target?.tagName === 'SCRIPT') {
          event.preventDefault();
          quarantine();
        }
      },
      true,
    );
    window.addEventListener('unhandledrejection', (event) => {
      event.preventDefault();
      quarantine();
    });
  }
  if (!embedded && !window.omnia) {
    if (home) home.href = '/launcher.html?return=1';
    return;
  }
  document.body.classList.add('native-tool');
  const content = document.createElement('div');
  content.className = 'native-scroll';
  for (const child of [...document.body.children])
    if (child.tagName !== 'SCRIPT' && child.tagName !== 'DIALOG') content.append(child);
  document.body.prepend(content);
  if (embedded) document.body.classList.add('embedded-tool');
  const back = async (event) => {
    event.preventDefault();
    try {
      if (window.omnia) await window.omnia.openTool('home');
      else await window.parent.omniaRouter.open('home');
    } catch (error) {
      window.parent.omniaRouter?.message(error.message);
    }
  };
  home?.addEventListener('click', back);
})();
