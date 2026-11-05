(() => {
  const shield =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v6c0 4-4 7-8 9-4-2-8-5-8-9V6z"/></svg>';
  let enabled = false;
  const selectors = {
    network: '[data-action],#confirm-run',
    drives: '[data-action^="drive-"]',
    drivers: '#backup-driver,#remove-driver,#confirm-driver-action',
    repair: '[data-repair-task],#repair-run',
    firewall:
      '#firewall-new,#firewall-edit,#firewall-toggle,#firewall-delete,#fw-editor-review,#fw-confirm-apply',
  };
  const controls = [selectors[document.body.dataset.tool], '[data-admin-required="true"]']
    .filter(Boolean)
    .join(',');
  function lockControls() {
    for (const button of document.querySelectorAll('[data-review-pending="true"]'))
      if (!button.disabled) button.disabled = true;
    if (enabled) return;
    for (const button of document.querySelectorAll(controls))
      if (!button.disabled) button.disabled = true;
  }
  window.omniaAdmin = {
    get enabled() {
      return enabled;
    },
    sync: lockControls,
  };
  if (selectors[document.body.dataset.tool]) {
    lockControls();
    new MutationObserver((records) => {
      if (
        records.some(
          (r) => r.type === 'attributes' || [...r.addedNodes].some((n) => n.nodeType === 1),
        )
      )
        lockControls();
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'data-admin-required'],
    });
    document.addEventListener(
      'click',
      (event) => {
        if (!enabled && event.target.closest?.(controls)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }
  window.omniaReview = async (dialog, submit, read, paint, requiresAdmin = true) => {
    if (dialog.open || (requiresAdmin && !enabled)) return null;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    const note = document.createElement('p');
    note.className = 'review-status';
    note.setAttribute('role', 'status');
    note.textContent = 'Checking current details…';
    dialog.prepend(note);
    dialog.dataset.preparing = 'true';
    dialog.dataset.adminReview = String(requiresAdmin);
    dialog.setAttribute('aria-busy', 'true');
    submit.disabled = true;
    submit.dataset.reviewPending = 'true';
    for (const button of dialog.querySelectorAll('button'))
      if (button !== submit) button.disabled = false;
    dialog.addEventListener('close', cancel);
    dialog.addEventListener('cancel', cancel);
    dialog.showModal();
    try {
      const plan = await read();
      if (cancelled || !dialog.open || (requiresAdmin && !enabled)) return null;
      paint(plan);
      delete submit.dataset.reviewPending;
      submit.disabled = false;
      return plan;
    } catch (error) {
      if (!cancelled && dialog.open) {
        note.textContent = error.message;
        submit.disabled = true;
      }
      return null;
    } finally {
      dialog.removeAttribute('aria-busy');
      dialog.removeEventListener('close', cancel);
      dialog.removeEventListener('cancel', cancel);
      if (!submit.disabled || cancelled) {
        delete submit.dataset.reviewPending;
        delete dialog.dataset.preparing;
        note.remove();
      } else
        dialog.addEventListener(
          'close',
          () => {
            delete submit.dataset.reviewPending;
            delete dialog.dataset.preparing;
            note.remove();
          },
          { once: true },
        );
    }
  };
  function badge(mode) {
    const el = document.createElement('span');
    el.className = 'admin-indicator';
    el.dataset.admin = mode;
    el.innerHTML = shield;
    el.setAttribute('role', 'img');
    return el;
  }
  function render(state) {
    enabled = !!state.enabled;
    lockControls();
    if (!enabled)
      for (const dialog of document.querySelectorAll('dialog[open][data-admin-review="true"]'))
        dialog.close();
    for (const el of document.querySelectorAll('.admin-indicator')) {
      const text =
        el.dataset.admin === 'required'
          ? 'Administrator permission required'
          : 'Administrator permission required for changes';
      el.classList.toggle('admin-granted', enabled);
      el.title = text + (enabled ? ' · Granted' : '');
      el.setAttribute('aria-label', el.title);
    }
    const note = document.querySelector('.admin-access-note');
    if (note) {
      note.querySelector('span').textContent = enabled
        ? 'Administrator access granted.'
        : note.dataset.mode === 'required'
          ? 'Administrator access is required to run these operations.'
          : 'Viewing is available. Administrator access is required to make changes.';
      note.querySelector('button').hidden = enabled;
    }
  }
  if (window.omniaTools) {
    for (const tool of window.omniaTools) {
      if (!tool.admin) continue;
      const card = document.querySelector('[data-tool="' + tool.id + '"]');
      if (!card) continue;
      card.querySelector('.tool-title').append(badge(tool.admin));
      const note = document.createElement('span');
      note.className = 'tool-admin-note';
      note.textContent = tool.admin === 'required' ? 'ADMIN REQUIRED' : 'ADMIN FOR CHANGES';
      card.querySelector('.tool-copy').append(note);
    }
  } else if (window.omnia) {
    window.omnia
      .toolInfo()
      .then((info) => {
        if (!info.tool?.admin || info.platform !== 'win32') return;
        document.querySelector('.converter-heading h1')?.append(badge(info.tool.admin));
        const note = document.createElement('div');
        note.className = 'admin-access-note';
        note.dataset.mode = info.tool.admin;
        note.append(document.createElement('span'));
        const button = document.createElement('button');
        button.textContent = 'Enable administrator access';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            render(await window.omnia.admin('enable'));
          } catch (error) {
            note.querySelector('span').textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        note.append(button);
        document.querySelector('.converter-heading')?.after(note);
        render({ enabled });
      })
      .catch(() => {});
  }
  if (window.omnia) {
    if (window.omniaTools)
      window.omnia
        .toolInfo()
        .then((info) => {
          if (info.platform !== 'win32')
            document
              .querySelectorAll('.admin-indicator,.tool-admin-note')
              .forEach((el) => el.remove());
        })
        .catch(() => {});
    window.omnia.onAdmin(render);
    window.omnia
      .admin('status')
      .then(render)
      .catch(() => {});
  } else render({ enabled: false });
})();
