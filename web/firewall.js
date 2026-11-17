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
    editing = false,
    securityChanged = false;
  function lock(value) {
    busy = value;
    $('#firewall-progress').hidden = !value;
    for (const b of document.querySelectorAll('button')) b.disabled = value;
    if (!value) {
      $('#firewall-new').disabled = !admin || !state.supported;
      $('#fw-type').disabled = editing;
      updateForm();
      actions();
    }
  }
  function actions() {
    const local = !!selected?.local;
    $('#firewall-actions').hidden = !selected;
    $('#firewall-toggle').textContent = selected?.values.enabled === 'True' ? 'Disable' : 'Enable';
    for (const id of ['firewall-toggle', 'firewall-edit', 'firewall-delete'])
      $('#' + id).disabled = busy || !admin || !local;
    $('#firewall-restriction').textContent = !selected
      ? ''
      : !local
        ? 'Managed or non-local rule: inspection only.'
        : !admin
          ? 'Enable the administrator shield to change this rule.'
          : 'Changes preserve additional conditions not shown in the edit form.';
  }
  function list() {
    const q = $('#firewall-search').value.toLowerCase(),
      filter = $('#firewall-filter').value,
      group = $('#firewall-group').value;
    const rows = (state.snapshot?.rules || []).filter(
      (r) =>
        (!q || JSON.stringify(r).toLowerCase().includes(q)) &&
        (!group || r.group === group) &&
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
        ['Authentication', v.authentication],
        ['Encryption', v.encryption],
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
    const group = $('#firewall-group').value;
    const groups = new Map();
    for (const r of state.snapshot?.rules || [])
      if (r.group) groups.set(r.group, r.displayGroup || r.group);
    for (const id of ['#firewall-group', '#fw-group']) {
      const control = $(id);
      control.replaceChildren(
        new Option(id === '#firewall-group' ? 'All groups' : 'Choose a group', ''),
      );
      for (const [value, name] of [...groups].sort((a, b) => a[1].localeCompare(b[1])))
        control.add(new Option(name, value));
    }
    $('#firewall-group').value = groups.has(group) ? group : '';
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
    securityChanged = false;
    const v = edit ? selected.values : null;
    $('#firewall-editor-title').textContent = edit ? 'EDIT RULE' : 'CREATE RULE';
    $('#fw-rule-form').reset();
    $('#fw-type').value = 'custom';
    $('#fw-type').disabled = edit;
    $('#fw-name').value = v?.displayName || '';
    $('#fw-direction').value = v?.direction || 'Inbound';
    $('#fw-action').value =
      v?.action === 'Allow' && ['Required', 'NoEncap'].includes(v.authentication)
        ? 'Secure'
        : v?.action || 'Block';
    $('#fw-authentication').value = v?.authentication === 'NoEncap' ? 'NoEncap' : 'Required';
    $('#fw-encryption').value = v?.encryption || 'NotRequired';
    const protocol =
      { 1: 'ICMPv4', 6: 'TCP', 17: 'UDP', 58: 'ICMPv6', 256: 'Any' }[v?.protocol] ||
      v?.protocol ||
      'TCP';
    $('#fw-protocol').value = ['TCP', 'UDP', 'Any', 'ICMPv4', 'ICMPv6'].includes(protocol)
      ? protocol
      : 'number';
    $('#fw-protocol-number').value = /^\d+$/.test(protocol) ? protocol : '0';
    $('#fw-local-port').value = v?.localPort.join(',') || 'Any';
    $('#fw-remote-port').value = v?.remotePort.join(',') || 'Any';
    $('#fw-remote-address').value = v?.remoteAddress.join(',') || 'LocalSubnet';
    $('#fw-local-address').value = v?.localAddress.join(',') || 'Any';
    $('#fw-program-scope').value = v?.program && v.program !== 'Any' ? 'path' : 'any';
    $('#fw-program').value = v?.program === 'Any' ? '' : v?.program || '';
    $('#fw-icmp').value = v?.icmp.join(',') || 'Any';
    $('#fw-service').value = v?.service || 'Any';
    $('#fw-interface').value = v?.interfaceType || 'Any';
    $('#fw-description').value = v?.description || '';
    for (const id of ['#fw-local-address', '#fw-service', '#fw-interface', '#fw-description'])
      $(id).dataset.initial = $(id).value;
    $('#fw-advanced-options').open = false;
    document
      .querySelectorAll('.fw-profile')
      .forEach(
        (c) =>
          (c.checked = v
            ? v.profile === 'Any' || v.profile.includes(c.value)
            : c.value === 'Private'),
      );
    $('#fw-editor-error').textContent = '';
    updateForm();
    $('#firewall-editor').showModal();
  }
  function protocol() {
    if ($('#fw-type').value === 'program') return 'Any';
    return $('#fw-protocol').value === 'number'
      ? $('#fw-protocol-number').value
      : $('#fw-protocol').value;
  }
  function updateForm() {
    const type = $('#fw-type').value,
      secure = $('#fw-action').value === 'Secure',
      ports = ['TCP', 'UDP', '6', '17'].includes(protocol()),
      icmp = ['ICMPv4', 'ICMPv6', '1', '58'].includes(protocol()),
      program = $('#fw-program-scope').value === 'path';
    $('#fw-predefined').hidden = type !== 'predefined';
    $('#fw-rule-form').hidden = type === 'predefined';
    $('#fw-type-help').textContent = {
      program: 'Control connections for one program or all programs.',
      port: 'Control TCP or UDP ports across all programs.',
      custom: 'Combine program, protocol, address and service conditions.',
      predefined: 'Browse rule groups installed on this computer.',
    }[type];
    $('#fw-security').hidden = !secure;
    $('#fw-encryption').disabled = $('#fw-authentication').value === 'NoEncap';
    if ($('#fw-encryption').disabled) $('#fw-encryption').value = 'NotRequired';
    $('#fw-program-section').hidden = type === 'port';
    $('#fw-program-path').hidden = !program;
    $('#fw-program').required = program && type !== 'port';
    $('#fw-choose-program').hidden = !program;
    $('#fw-protocol-field').hidden = type === 'program';
    for (const option of $('#fw-protocol').options)
      option.disabled = type === 'port' && !['TCP', 'UDP'].includes(option.value);
    $('#fw-protocol-number-field').hidden =
      type === 'program' || $('#fw-protocol').value !== 'number';
    $('#fw-local-port-field').hidden =
      $('#fw-remote-port-field').hidden =
      $('#fw-port-help').hidden =
        !ports;
    $('#fw-icmp-field').hidden = !icmp;
    $('#fw-show-group').disabled = !$('#fw-group').value;
  }
  function spec() {
    const p = protocol(),
      secure = $('#fw-action').value === 'Secure';
    const result = {
      displayName: $('#fw-name').value.trim(),
      direction: $('#fw-direction').value,
      action: secure ? 'Allow' : $('#fw-action').value,
      protocol: p,
      localPort: ['TCP', 'UDP', '6', '17'].includes(p)
        ? $('#fw-local-port').value.replace(/\s/g, '')
        : 'Any',
      remotePort: ['TCP', 'UDP', '6', '17'].includes(p)
        ? $('#fw-remote-port').value.replace(/\s/g, '')
        : 'Any',
      remoteAddress: $('#fw-remote-address').value.replace(/\s/g, ''),
      program:
        $('#fw-type').value === 'port' || $('#fw-program-scope').value === 'any'
          ? 'Any'
          : $('#fw-program').value.trim(),
      profiles: [...document.querySelectorAll('.fw-profile:checked')].map((c) => c.value),
    };
    if (!result.profiles.length) throw Error('Choose at least one network profile.');
    if ($('#fw-type').value === 'port' && result.localPort === 'Any' && result.remotePort === 'Any')
      throw Error('Enter a local or remote port. Use Custom for all ports.');
    const extra = {
      localAddress: $('#fw-local-address').value.replace(/\s/g, ''),
      service: $('#fw-service').value.trim(),
      interfaceType: $('#fw-interface').value,
      description: $('#fw-description').value,
      icmp: ['ICMPv4', 'ICMPv6', '1', '58'].includes(p)
        ? $('#fw-icmp').value.replace(/\s/g, '')
        : 'Any',
    };
    for (const [k, v] of Object.entries(extra)) {
      const current = selected?.values[k];
      const field = {
        localAddress: '#fw-local-address',
        service: '#fw-service',
        interfaceType: '#fw-interface',
        description: '#fw-description',
      }[k];
      const initial = field
        ? $(field).dataset.initial
        : Array.isArray(current)
          ? current.join(',')
          : current;
      if (!editing || v !== initial) result[k] = v;
    }
    const authentication = secure ? $('#fw-authentication').value : 'NotRequired';
    const encryption = secure ? $('#fw-encryption').value : 'NotRequired';
    if (!editing || securityChanged) {
      result.authentication = authentication;
      result.encryption = encryption;
    }
    return result;
  }
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
          const after = plan.summary.after;
          if (after?.program === 'Any' && after.localPort === 'Any' && after.remotePort === 'Any')
            $('#firewall-plan').textContent +=
              '\n\nAll programs and all ports are included. The selected protocol, addresses, profiles and other conditions still apply.';
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
  for (const id of ['#firewall-filter', '#firewall-group'])
    $(id).addEventListener('change', () => {
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
      if (p) {
        $('#fw-program').value = p;
        $('#fw-program-scope').value = 'path';
        updateForm();
      }
    }),
  );
  for (const id of [
    '#fw-program-scope',
    '#fw-action',
    '#fw-protocol',
    '#fw-protocol-number',
    '#fw-authentication',
    '#fw-group',
  ])
    $(id).addEventListener('change', updateForm);
  for (const id of ['#fw-action', '#fw-authentication', '#fw-encryption'])
    $(id).addEventListener('change', () => {
      securityChanged = true;
    });
  $('#fw-type').addEventListener('change', () => {
    if ($('#fw-type').value === 'port' && !['TCP', 'UDP'].includes(protocol()))
      $('#fw-protocol').value = 'TCP';
    updateForm();
  });
  $('#fw-show-group').addEventListener('click', () => {
    $('#firewall-group').value = $('#fw-group').value;
    $('#firewall-filter').value = 'all';
    $('#firewall-search').value = '';
    offset = 0;
    list();
    $('#firewall-editor').close();
    $('#firewall-count').scrollIntoView({ block: 'start' });
  });
  $('#fw-connection-security').addEventListener(
    'click',
    safe(() => api('advanced')),
  );
  $('#fw-editor-cancel').addEventListener('click', () => $('#firewall-editor').close());
  $('#fw-group-cancel').addEventListener('click', () => $('#firewall-editor').close());
  $('#fw-rule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await review(editing ? 'edit' : 'create', { spec: spec() });
    } catch (e) {
      if ($('#firewall-confirm').open) $('#firewall-confirm-error').textContent = e.message;
      else $('#fw-editor-error').textContent = e.message;
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
