(() => {
  const { $, el, message, safe, details } = window.systemUI;
  const api = (action, data = {}) => window.omnia.ssh(action, data);
  let mode = 'generate',
    state = null,
    timer,
    busy = false;
  const on = (id, fn) => $(id).addEventListener('click', safe(fn));
  function clearSecrets() {
    for (const id of ['#ssh-passphrase', '#ssh-confirm', '#ssh-old-passphrase']) $(id).value = '';
  }
  function sizes() {
    const type = $('#ssh-algorithm').value,
      values =
        type === 'ed25519' ? [256] : type === 'rsa' ? [2048, 3072, 4096, 8192] : [256, 384, 521];
    $('#ssh-bits').replaceChildren(
      ...values.map((n) => {
        const option = el('option', n + ' bits');
        option.value = n;
        return option;
      }),
    );
    if (type === 'rsa') $('#ssh-bits').value = 3072;
    $('#ssh-bits').disabled = type === 'ed25519';
    $('#ssh-algorithm-note').textContent =
      type === 'ed25519'
        ? 'Compact keys for modern SSH clients and services.'
        : type === 'rsa'
          ? 'Use RSA when compatibility requires it. RSA keys can use SHA-2 signatures. Larger keys take longer to generate.'
          : 'Uses the selected NIST elliptic curve.';
    if (/^ssh-key-(ed25519|rsa|ecdsa)$/.test($('#ssh-name').value))
      $('#ssh-name').value = 'ssh-key-' + type;
  }
  function show(next) {
    state = next;
    $('#ssh-version').textContent = next.capability?.version || 'Unavailable';
    $('#ssh-provider').textContent = next.capability?.available
      ? next.capability.executable
      : next.capability?.message || 'Checking local OpenSSH.';
    $('#ssh-source-path').textContent = next.selection
      ? `${next.selection.kind === 'private' ? 'Private key' : 'Public key'} · ${next.selection.path}`
      : 'Select one public or private key.';
    $('#ssh-output-path').textContent = next.destination || 'No output folder selected.';
    $('#ssh-result').hidden = !next.result;
    $('#ssh-run').disabled = busy || !next.capability?.available;
    if (next.result) {
      const r = next.result;
      $('#ssh-public').textContent = r.line;
      $('#ssh-randomart').textContent = r.randomart;
      details($('#ssh-details'), [
        ['Algorithm', r.type],
        ['Key size', r.bits + ' bits'],
        ['SHA-256 fingerprint', r.fingerprint],
        [
          'Protection',
          r.encrypted === true
            ? 'Passphrase encrypted'
            : r.encrypted === false
              ? 'Unencrypted'
              : 'Public key',
        ],
        ['Permissions', r.permissions || 'Source unchanged'],
        ['Private key', r.privatePath || 'Not exported'],
        ['Public key', r.publicPath || 'Available above'],
        ...(r.sourcePath ? [['Source key', r.sourcePath]] : []),
      ]);
      $('#ssh-show-folder').hidden = !r.privatePath;
      for (const option of $('#ssh-format').options)
        option.disabled = ['PKCS8', 'PEM'].includes(option.value) && r.type === 'ssh-ed25519';
      if ($('#ssh-format').selectedOptions[0].disabled) $('#ssh-format').value = 'openssh';
    }
  }
  function setMode(value) {
    if (busy) return;
    mode = value;
    clearSecrets();
    for (const b of document.querySelectorAll('[data-mode]'))
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    $('#ssh-source').hidden = mode === 'generate';
    $('#ssh-create').hidden = mode === 'inspect';
    $('#ssh-destination').hidden = mode === 'inspect';
    $('#ssh-algorithms').hidden = mode !== 'generate';
    $('#ssh-algorithm-note').hidden = mode !== 'generate';
    $('#ssh-run span').textContent =
      mode === 'generate'
        ? 'Create key pair'
        : mode === 'inspect'
          ? 'Inspect key'
          : 'Save protected copy';
  }
  function controls(value) {
    busy = value;
    for (const button of document.querySelectorAll('button')) button.disabled = value;
    $('#ssh-cancel').disabled = false;
    $('#ssh-cancel').hidden = !value;
    $('#ssh-progress').hidden = !value;
    for (const input of document.querySelectorAll('input,select')) input.disabled = value;
    if (!value) {
      $('#ssh-run').disabled = !state?.capability?.available;
      $('#ssh-bits').disabled = $('#ssh-algorithm').value === 'ed25519';
    }
  }
  async function progress() {
    if (!busy) return;
    try {
      const current = await api('status');
      message(current.phase === 'idle' ? 'Finishing…' : current.phase + '…');
    } finally {
      if (busy) timer = setTimeout(safe(progress), 700);
    }
  }
  on('#ssh-refresh', async () => {
    show(await api('refresh'));
    message(state.capability.available ? 'OpenSSH is ready.' : state.capability.message);
  });
  on('#ssh-folder', async () => show(await api('folder')));
  on('#ssh-drop', async () => {
    clearSecrets();
    show(await window.omniaFeedback.check($('#ssh-drop'), () => api('choose')));
  });
  const zone = $('#ssh-drop');
  for (const event of ['dragenter', 'dragover'])
    zone.addEventListener(event, (e) => {
      e.preventDefault();
      if (!busy) zone.classList.add('dragging');
    });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  document.addEventListener(
    'drop',
    safe(async (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      if (busy) return message('Finish or cancel the current operation before adding a key.');
      if (mode === 'generate') setMode('inspect');
      clearSecrets();
      show(await window.omniaFeedback.check(zone, () => window.omnia.dropKey(files)));
    }),
  );
  document.addEventListener('dragover', (e) => e.preventDefault());
  for (const button of document.querySelectorAll('[data-mode]'))
    button.addEventListener('click', () => setMode(button.dataset.mode));
  $('#ssh-algorithm').addEventListener('change', sizes);
  $('#ssh-unencrypted').addEventListener(
    'change',
    () => ($('#ssh-empty-warning').hidden = !$('#ssh-unencrypted').checked),
  );
  on('#ssh-run', async () => {
    const options = {
      algorithm: $('#ssh-algorithm').value,
      bits: Number($('#ssh-bits').value),
      rounds: Number($('#ssh-rounds').value),
      comment: $('#ssh-comment').value,
      name: $('#ssh-name').value,
      passphrase: $('#ssh-passphrase').value,
      confirm: $('#ssh-confirm').value,
      oldPassphrase: $('#ssh-old-passphrase').value,
      allowEmpty: $('#ssh-unencrypted').checked,
    };
    const request = api(mode, mode === 'inspect' ? { passphrase: options.oldPassphrase } : options);
    clearSecrets();
    options.passphrase = options.confirm = options.oldPassphrase = '';
    controls(true);
    message('Starting…');
    timer = setTimeout(safe(progress), 500);
    try {
      show(await request);
      message(
        mode === 'inspect'
          ? 'Key inspected. The source file is unchanged.'
          : 'Key pair saved. Keep the private key and its passphrase safe.',
      );
      $('#ssh-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) {
      message(e.message);
    } finally {
      clearTimeout(timer);
      controls(false);
    }
  });
  on('#ssh-cancel', async () => {
    await api('cancel');
    message('Cancelling…');
  });
  on('#ssh-clear', async () => {
    clearSecrets();
    show(await api('clear'));
    window.omniaFeedback.clear(zone);
    $('#ssh-public').textContent = '';
    $('#ssh-details').replaceChildren();
    $('#ssh-randomart').textContent = '';
    $('#ssh-comment').value = '';
    $('#ssh-unencrypted').checked = false;
    $('#ssh-empty-warning').hidden = true;
    message('Cleared. Saved keys remain on disk.');
  });
  on('#ssh-copy-public', async () => {
    await api('copy', { kind: 'public' });
    message('Public key copied.');
  });
  on('#ssh-copy-fingerprint', async () => {
    await api('copy', { kind: 'fingerprint' });
    message('Fingerprint copied.');
  });
  on('#ssh-show-folder', () => api('reveal'));
  on('#ssh-export', async () => {
    const saved = await api('export', { format: $('#ssh-format').value });
    if (saved) message('Public key saved.');
  });
  window.addEventListener(
    'omnia:page-visible',
    safe(async () => show(await api('status'))),
  );
  sizes();
  safe(async () => {
    show(await api('refresh'));
    message(
      state.capability.available
        ? 'Choose key settings and an output folder.'
        : state.capability.message,
    );
  })();
})();
