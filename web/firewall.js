(() => {
  const { $, el, message, safe, button, details, download } = systemUI,
    api = (a, d = {}) => window.omnia.firewall(a, d);
  let state = {},
    selected = null,
    selectedName = '',
    offset = 0,
    admin = false,
    busy = false,
    plan = null,
    editing = false;
  function lock(value) {
    busy = value;
    $('#firewall-progress').hidden = !value;
    for (const b of document.querySelectorAll('button')) b.disabled = value;
    if (!value) {
      $('#firewall-new').disabled = !admin || !state.supported;
      actions();
    }
  }
  function actions() {
    const local = !!selected?.local;
    $('#firewall-actions').hidden = !selected;
    $('#firewall-toggle').textContent = selected?.values.enabled === 'True' ? 'Disable' : 'Enable';
    for (const id of ['firewall-toggle', 'firewall-edit', 'firewall-delete'])
      $('#' + id).disabled = busy || !admin || !local;
    const protocol = selected?.values.protocol;
    const editable = ['TCP', 'UDP', 'Any', '6', '17', '256'].includes(protocol);
    if (!editable) $('#firewall-edit').disabled = true;
    $('#firewall-restriction').textContent = !selected
      ? ''
      : !local
        ? 'Managed or non-local rule: inspection only.'
        : !admin
          ? 'Enable the administrator shield to change this rule.'
          : !editable
            ? 'This protocol cannot be edited in the application/port form. Enable, disable and deletion remain available.'
            : 'Changes preserve additional conditions not shown in the edit form.';
  }
  function list() {
    const q = $('#firewall-search').value.toLowerCase(),
      filter = $('#firewall-filter').value;
    const rows = (state.snapshot?.rules || []).filter(
      (r) =>
        (!q || JSON.stringify(r).toLowerCase().includes(q)) &&
        (filter === 'all' ||
          (filter === 'enabled' && r.enabled === 'True') ||
          (filter === 'disabled' && r.enabled !== 'True') ||
          (filter === 'inbound' && r.direction === 'Inbound') ||
          (filter === 'outbound' && r.direction === 'Outbound') ||
          (filter === 'local' && r.local) ||
          (filter === 'managed' && !r.local)),
    );
    offset = Math.min(offset, Math.max(0, Math.floor((rows.length - 1) / 100) * 100));
    $('#firewall-count').textContent =
      rows.length +
      ' rules · ' +
      (rows.length ? offset + 1 : 0) +
      '–' +
      Math.min(offset + 100, rows.length);
    $('#firewall-rows').replaceChildren();
    for (const r of rows.slice(offset, offset + 100)) {
      const tr = el('tr'),
        name = el('td');
      tr.setAttribute('aria-selected', String(r.name === selectedName));
      name.append(
        button(r.displayName, () => select(r.name)),
        el('div', r.direction + ' · ' + r.profile, 'system-subtitle'),
      );
      tr.append(name, el('td', r.enabled === 'True' ? 'Enabled' : 'Disabled'), el('td', r.action));
      $('#firewall-rows').append(tr);
    }
    $('#firewall-prev').disabled = busy || !offset;
    $('#firewall-next').disabled = busy || offset + 100 >= rows.length;
  }
  async function select(name) {
    if (busy) return;
    lock(true);
    try {
      selected = await api('detail', { name });
      selectedName = name;
      const v = selected.values;
      $('#firewall-detail-title').textContent = v.displayName;
      details($('#firewall-detail'), [
        ['Rule ID', v.name],
        ['Direction', v.direction],
        ['Action', v.action],
        ['Enabled', v.enabled],
        ['Profiles', v.profile],
        ['Application', v.program],
        ['Protocol', v.protocol],
        ['Local ports', v.localPort],
        ['Remote ports', v.remotePort],
        ['Local addresses', v.localAddress],
        ['Remote addresses', v.remoteAddress],
      ]);
      details(
        $('#firewall-advanced'),
        Object.entries(v).filter(
          ([k]) =>
            ![
              'name',
              'displayName',
              'direction',
              'action',
              'enabled',
              'profile',
              'program',
              'protocol',
              'localPort',
              'remotePort',
              'localAddress',
              'remoteAddress',
            ].includes(k),
        ),
      );
      list();
    } finally {
      lock(false);
    }
  }
  function render() {
    const root = $('#firewall-profiles');
    root.replaceChildren();
    for (const p of state.snapshot?.profiles || []) {
      const card = el('article', undefined, 'disk-card');
      card.append(
        el('h2', p.name),
        el('div', p.enabled ? 'ON' : 'OFF', 'system-stat'),
        el(
          'p',
          'Default inbound: ' +
            p.inbound +
            ' · outbound: ' +
            p.outbound +
            ' · local rules: ' +
            p.localRules,
          'system-subtitle',
        ),
      );
      root.append(card);
    }
    list();
    $('#firewall-history').replaceChildren();
    for (const h of (state.history || []).slice(0, 30)) {
      const row = el('div', undefined, 'volume');
      row.append(
        el('p', h.operation.toUpperCase() + ' · ' + h.name, 'option-note'),
        el(
          'p',
          new Date(h.time).toLocaleString() +
            (h.undone
              ? ' · Undone'
              : h.pending
                ? ' · Incomplete operation; inspect the current rule before taking further action.'
                : h.error
                  ? ' · ' + h.error
                  : ''),
          'system-subtitle',
        ),
      );
      if (!h.undone && !h.pending && !h.error) {
        const b = button('Review undo', () => review('undo', { id: h.id }));
        b.dataset.adminRequired = 'true';
        b.disabled = !admin || busy;
        row.append(b);
      }
      $('#firewall-history').append(row);
    }
    if (!state.history?.length)
      $('#firewall-history').append(el('p', 'No changes made through OMNIA.', 'option-note'));
    actions();
  }
  async function refresh() {
    if (busy) return;
    lock(true);
    message('Reading firewall profiles and rules…');
    try {
      state = await api('refresh');
      selected = null;
      selectedName = '';
      $('#firewall-detail-title').textContent = 'Select a rule';
      $('#firewall-detail').replaceChildren();
      $('#firewall-advanced').replaceChildren();
      render();
      message('Rules refreshed. Nothing was changed.');
    } finally {
      lock(false);
    }
  }
  function editor(edit) {
    editing = edit;
    const v = edit ? selected.values : null;
    $('#firewall-editor-title').textContent = edit ? 'EDIT RULE SCOPE' : 'CREATE RULE';
    $('#fw-name').value = v?.displayName || '';
    $('#fw-direction').value = v?.direction || 'Inbound';
    $('#fw-action').value = v?.action || 'Block';
    $('#fw-protocol').value =
      { 6: 'TCP', 17: 'UDP', 256: 'Any' }[v?.protocol] || v?.protocol || 'TCP';
    $('#fw-local-port').value = v?.localPort.join(',') || 'Any';
    $('#fw-remote-port').value = v?.remotePort.join(',') || 'Any';
    $('#fw-remote-address').value = v?.remoteAddress.join(',') || 'LocalSubnet';
    $('#fw-program').value = v?.program || 'Any';
    document
      .querySelectorAll('.fw-profile')
      .forEach(
        (c) =>
          (c.checked = v
            ? v.profile === 'Any' || v.profile.includes(c.value)
            : c.value === 'Private'),
      );
    $('#fw-editor-error').textContent = '';
    $('#firewall-editor').showModal();
  }
  const spec = () => ({
    displayName: $('#fw-name').value.trim(),
    direction: $('#fw-direction').value,
    action: $('#fw-action').value,
    protocol: $('#fw-protocol').value,
    localPort: $('#fw-local-port').value.replace(/\s/g, ''),
    remotePort: $('#fw-remote-port').value.replace(/\s/g, ''),
    remoteAddress: $('#fw-remote-address').value.replace(/\s/g, ''),
    program: $('#fw-program').value,
    profiles: [...document.querySelectorAll('.fw-profile:checked')].map((c) => c.value),
  });
  function summarize(s) {
    if (!s || typeof s !== 'object') return String(s);
    return Object.entries(s)
      .map(
        ([k, v]) =>
          k +
          ': ' +
          (v && typeof v === 'object' && !Array.isArray(v)
            ? '\n' + summarize(v)
            : Array.isArray(v)
              ? v.join(', ')
              : String(v)),
      )
      .join('\n');
  }
  async function review(operation, data = {}) {
    if (busy || !admin) return;
    lock(true);
    try {
      plan = null;
      $('#firewall-editor').close();
      plan = await window.omniaReview(
        $('#firewall-confirm'),
        $('#fw-confirm-apply'),
        () => api('prepare', { operation, name: selectedName, ...data }),
        (plan) => {
          $('#firewall-plan').textContent =
            operation.toUpperCase() + '\n\n' + summarize(plan.summary);
          $('#firewall-confirm-error').textContent = '';
        },
      );
    } finally {
      lock(false);
    }
  }
  $('#firewall-refresh').addEventListener('click', safe(refresh));
  $('#firewall-new').addEventListener('click', () => editor(false));
  $('#firewall-edit').addEventListener('click', () => editor(true));
  $('#firewall-toggle').addEventListener(
    'click',
    safe(() => review(selected.values.enabled === 'True' ? 'disable' : 'enable')),
  );
  $('#firewall-delete').addEventListener(
    'click',
    safe(() => review('delete')),
  );
  $('#firewall-search').addEventListener('input', () => {
    offset = 0;
    list();
  });
  $('#firewall-filter').addEventListener('change', () => {
    offset = 0;
    list();
  });
  $('#firewall-prev').addEventListener('click', () => {
    offset = Math.max(0, offset - 100);
    list();
  });
  $('#firewall-next').addEventListener('click', () => {
    offset += 100;
    list();
  });
  $('#fw-choose-program').addEventListener(
    'click',
    safe(async () => {
      const p = await api('program');
      if (p) $('#fw-program').value = p;
    }),
  );
  $('#fw-any-program').addEventListener('click', () => ($('#fw-program').value = 'Any'));
  $('#fw-editor-cancel').addEventListener('click', () => $('#firewall-editor').close());
  $('#fw-editor-review').addEventListener('click', async () => {
    try {
      await review(editing ? 'edit' : 'create', { spec: spec() });
    } catch (e) {
      $('#fw-editor-error').textContent = e.message;
    }
  });
  $('#fw-confirm-cancel').addEventListener('click', () => {
    $('#firewall-confirm').close();
    plan = null;
  });
  $('#fw-confirm-apply').addEventListener('click', async () => {
    if (!plan || busy) return;
    lock(true);
    try {
      state = await api('execute', { token: plan.token });
      plan = null;
      $('#firewall-confirm').close();
      selected = null;
      render();
      message('Change completed. Refresh rules to see the current effective state.');
    } catch (e) {
      $('#firewall-confirm-error').textContent = e.message;
      plan = null;
    } finally {
      lock(false);
    }
  });
  $('#firewall-export').addEventListener('click', () =>
    download('omnia-firewall.json', { ...state, selected }),
  );
  if (!window.omnia?.firewall) {
    message('Open Firewall Manager in the OMNIA desktop app.');
    return;
  }
  window.omnia.onAdmin((s) => {
    admin = s.enabled;
    render();
    lock(busy);
  });
  safe(async () => {
    admin = (await window.omnia.admin('status')).enabled;
    state = await api('status');
    if (!state.supported) {
      message('Firewall Manager currently supports Windows.');
      lock(false);
      return;
    }
    await refresh();
  })();
})();
