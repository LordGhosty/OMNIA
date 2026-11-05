(() => {
  const $ = (selector) => document.querySelector(selector);
  let state = { snapshot: null },
    view = 'packages',
    selected = '',
    busy = false,
    plan = null,
    adminEnabled = false;
  const api = (action, data = {}) => window.omnia.drivers(action, data);
  const message = (text) => ($('#driver-status').textContent = text);
  const safe =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (error) {
        message(error.message);
      }
    };
  const item = () =>
    state.snapshot?.[view]?.find((row) => (view === 'packages' ? row.inf : row.name) === selected);
  function lock(value) {
    busy = value;
    for (const button of document.querySelectorAll('button')) button.disabled = value;
    $('#driver-progress').hidden = !value;
    for (const input of document.querySelectorAll('input,select')) input.disabled = value;
    $('#driver-filter').disabled = value || view === 'services';
    if (!value) detail();
  }
  function list() {
    const query = $('#driver-search').value.trim().toLowerCase(),
      filter = $('#driver-filter').value;
    const rows = (state.snapshot?.[view] || []).filter(
      (p) =>
        (!query || JSON.stringify(p).toLowerCase().includes(query)) &&
        (filter === 'all' ||
          (filter === 'review' && !p.devices.length) ||
          (filter === 'connected' && p.devices.some((d) => d.present === true)) ||
          (filter === 'protected' && p.protectedReason) ||
          (filter === 'warnings' && p.risk?.level !== 'standard')),
    );
    if (!rows.some((row) => (view === 'packages' ? row.inf : row.name) === selected))
      selected = rows[0] ? (view === 'packages' ? rows[0].inf : rows[0].name) : '';
    $('#driver-match-count').textContent = rows.length;
    const root = $('#driver-list');
    root.replaceChildren();
    for (const row of rows) {
      const button = document.createElement('button'),
        name = document.createElement('strong'),
        sub = document.createElement('small');
      button.className = 'driver-row';
      const id = view === 'packages' ? row.inf : row.name;
      button.setAttribute('aria-pressed', String(id === selected));
      button.disabled = busy;
      name.textContent =
        view === 'packages'
          ? (row.provider || 'Unknown publisher') + ' / ' + row.inf
          : row.displayName || row.name;
      sub.textContent =
        view === 'packages'
          ? (row.risk?.level !== 'standard' ? '⚠ WARNING · ' : '') +
            (row.class || 'Unknown class') +
            ' · ' +
            row.usage
          : row.name + ' · ' + row.state + ' · ' + row.startMode;
      button.append(name, sub);
      button.addEventListener('click', () => {
        selected = id;
        list();
      });
      root.append(button);
    }
    if (!rows.length) root.textContent = 'No matching entries.';
    detail();
  }
  function details(entries) {
    const root = $('#driver-details');
    root.replaceChildren();
    for (const [label, value] of entries) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value == null || value === '' ? 'Not reported' : String(value);
      root.append(dt, dd);
    }
  }
  function detail() {
    const row = item(),
      packages = view === 'packages';
    $('#driver-actions').hidden = !row;
    $('#driver-device-section').hidden = !row || !packages;
    $('#driver-risk').hidden = !row || !packages;
    $('#driver-title').textContent = row
      ? packages
        ? row.inf
        : row.displayName || row.name
      : 'Select an entry';
    $('#driver-details').replaceChildren();
    $('#driver-protection').textContent = '';
    $('#driver-devices').replaceChildren();
    if (!row) return;
    $('#backup-driver').hidden = $('#remove-driver').hidden = !packages;
    $('#reveal-driver').textContent = packages
      ? 'Show INF in folder ↗'
      : 'Show binary in folder ↗';
    if (packages) {
      $('#driver-risk-title').textContent =
        row.risk.level === 'standard' ? 'BEFORE REMOVAL' : '⚠ WARNING';
      $('#driver-risk-reason').textContent = row.risk.reason;
      $('#driver-risk-basis').textContent = row.risk.basis;
      details([
        ['Publisher', row.provider],
        ['Original INF', row.original],
        ['Published INF', row.inf],
        ['Version', row.version],
        ['Driver date', row.date],
        ['Class', row.class],
        ['Usage', row.usage],
        ['Linked devices', row.devices.length],
        [
          'Signed (device reports)',
          row.devices.length
            ? [
                ...new Set(
                  row.devices.map((d) =>
                    d.signed === true ? 'Yes' : d.signed === false ? 'No' : 'Unknown',
                  ),
                ),
              ].join(', ')
            : 'No associated device report',
        ],
        ['Signer', [...new Set(row.devices.map((d) => d.signer).filter(Boolean))].join('\n')],
        [
          'Linked driver services',
          row.services.map((s) => s.name + ' · ' + s.state + ' · ' + s.startMode).join('\n'),
        ],
      ]);
      $('#driver-protection').textContent =
        row.protectedReason ||
        (!adminEnabled
          ? 'Enable the administrator shield to back up or review removal.'
          : 'Review the publisher and linked devices before removal. A disconnected device may still need this package.');
      $('#backup-driver').disabled = $('#remove-driver').disabled =
        busy || !!row.protectedReason || !adminEnabled;
      for (const device of row.devices) {
        const div = document.createElement('div'),
          name = document.createElement('strong'),
          info = document.createElement('p');
        div.className = 'driver-device';
        name.textContent = device.name || device.id;
        info.textContent = [
          device.present === true
            ? 'Connected'
            : device.present === false
              ? 'Disconnected'
              : 'Presence unknown',
          device.problem != null ? 'Device problem code: ' + device.problem : '',
          device.id,
        ]
          .filter(Boolean)
          .join('\n');
        div.append(name, info);
        $('#driver-devices').append(div);
      }
      if (!row.devices.length)
        $('#driver-devices').textContent =
          'No association found in Windows device records. This is not proof that the package is unnecessary.';
    } else {
      details([
        ['Service name', row.name],
        ['Display name', row.displayName],
        ['State', row.state],
        ['Start mode', row.startMode],
        ['Driver type', row.type],
        ['Binary path', row.path],
        ['Error control', row.errorControl],
      ]);
      $('#driver-protection').textContent =
        'Driver services are shown for inspection. Use the software’s uninstaller to remove standalone services; package removal is available in the Driver packages tab.';
    }
  }
  function render() {
    $('#driver-results').hidden = !state.snapshot;
    if (state.snapshot) {
      const s = state.snapshot;
      $('#package-count').textContent = '(' + s.packages.length + ')';
      $('#service-count').textContent = '(' + s.services.length + ')';
      $('#driver-scan-time').textContent = 'Scanned ' + new Date(s.checkedAt).toLocaleString();
      $('#driver-coverage').textContent = s.completeStore
        ? 'Windows and third-party Driver Store packages + device associations + driver services. Built-in Windows packages are inspection-only.'
        : 'Device-associated packages + driver services. Enable the administrator shield and scan again to include unassigned Driver Store packages.';
      list();
    }
    $('#driver-last-result').hidden = !state.lastResult;
    if (state.lastResult) {
      const r = state.lastResult;
      $('#driver-operation-summary').textContent =
        (r.action === 'driver-remove'
          ? 'Windows completed the removal request for '
          : 'Backed up ') +
        r.inf +
        '. ' +
        (r.restartRequired
          ? 'Windows requires a restart. Save your work and restart when ready. '
          : '') +
        'Backup: ' +
        r.backup;
      $('#driver-operation-output').textContent = r.output;
    }
  }
  async function scan() {
    if (busy) return;
    lock(true);
    message('Reading Windows driver records…');
    try {
      state = await api('scan');
      render();
      message(
        state.snapshot.issues.length
          ? state.snapshot.issues.join(' / ')
          : 'Scan complete. Nothing was changed.',
      );
    } finally {
      lock(false);
    }
  }
  async function prepare(action) {
    if (busy || !item() || !adminEnabled) return;
    lock(true);
    message('Checking the selected package and its devices…');
    try {
      plan = null;
      plan = await window.omniaReview(
        $('#driver-confirm'),
        $('#confirm-driver-action'),
        () => api('prepare', { action, inf: item().inf }),
        (plan) => {
          const removal = action === 'driver-remove';
          $('#driver-confirm-title').textContent = removal
            ? 'REMOVE DRIVER PACKAGE'
            : 'BACK UP DRIVER PACKAGE';
          $('#driver-confirm-summary').textContent =
            plan.item.provider + ' · ' + plan.item.inf + ' · ' + plan.item.version;
          $('#driver-confirm-devices').replaceChildren();
          for (const d of plan.item.devices) {
            const li = document.createElement('li');
            li.textContent =
              (d.name || d.id) +
              ' — ' +
              (d.present === true
                ? 'connected'
                : d.present === false
                  ? 'disconnected'
                  : 'presence unknown');
            $('#driver-confirm-devices').append(li);
          }
          $('#driver-confirm-warning').textContent = removal
            ? 'A verified package backup is required before removal. Linked devices may stop working, including display, audio or networking. Windows can require a restart. The parent application is not uninstalled.'
            : 'Export the complete driver package into a new OMNIA backup folder. Nothing will be uninstalled.';
          $('#driver-confirm-risk').hidden = !removal;
          $('#driver-confirm-risk-title').textContent =
            plan.item.risk.level === 'standard' ? 'BEFORE REMOVAL' : '⚠ WARNING';
          $('#driver-confirm-risk-reason').textContent = plan.item.risk.reason;
          $('#driver-confirm-risk-basis').textContent = plan.item.risk.basis;
          $('#driver-risk-ack-label').hidden = !removal || plan.item.risk.level === 'standard';
          $('#driver-risk-ack').checked = false;
          $('#driver-command').textContent = removal
            ? 'pnputil /export-driver ' +
              plan.item.inf +
              ' <backup folder>\npnputil /delete-driver ' +
              plan.item.inf +
              ' /uninstall'
            : 'pnputil /export-driver ' + plan.item.inf + ' <backup folder>';
          $('#driver-phrase-label').hidden = $('#driver-phrase').hidden = !removal;
          $('#driver-phrase-label').textContent = 'TYPE ' + plan.phrase + ' TO CONFIRM';
          $('#driver-phrase').value = '';
          $('#driver-confirm-error').textContent = '';
        },
      );
      if (plan) message('Review the selected package.');
    } finally {
      lock(false);
    }
  }
  $('#scan-drivers').addEventListener('click', safe(scan));
  $('#driver-search').addEventListener('input', list);
  $('#driver-filter').addEventListener('change', list);
  document.querySelectorAll('[data-view]').forEach((button) =>
    button.addEventListener('click', () => {
      view = button.dataset.view;
      selected = '';
      $('#driver-filter').value = 'all';
      $('#driver-filter').disabled = view === 'services';
      document
        .querySelectorAll('[data-view]')
        .forEach((b) => b.setAttribute('aria-selected', String(b === button)));
      $('#driver-content').setAttribute('aria-labelledby', button.id);
      $('#driver-scope-note').textContent =
        view === 'packages'
          ? 'No device association does not mean a package is unused. Disconnected hardware and software may need it later.'
          : 'Kernel and file-system driver services. These are distinct from ordinary application services, startup entries and scheduled tasks.';
      list();
    }),
  );
  $('#backup-driver').addEventListener(
    'click',
    safe(() => prepare('driver-backup')),
  );
  $('#remove-driver').addEventListener(
    'click',
    safe(() => prepare('driver-remove')),
  );
  $('#cancel-driver-action').addEventListener('click', () => {
    $('#driver-confirm').close();
    plan = null;
  });
  $('#confirm-driver-action').addEventListener(
    'click',
    safe(async () => {
      if (!plan || busy) return;
      const phrase = $('#driver-phrase').value;
      if (phrase !== plan.phrase) {
        $('#driver-confirm-error').textContent = 'Type the confirmation phrase exactly as shown.';
        return;
      }
      const acknowledgedRisk = $('#driver-risk-ack').checked;
      if (
        plan.action === 'driver-remove' &&
        plan.item.risk.level !== 'standard' &&
        !acknowledgedRisk
      ) {
        $('#driver-confirm-error').textContent =
          'Read and acknowledge the driver warning before continuing.';
        return;
      }
      $('#driver-confirm').close();
      lock(true);
      message(
        'Backing up the driver package' +
          (plan.action === 'driver-remove' ? ', then asking Windows to remove it…' : '…'),
      );
      try {
        state.lastResult = await api('execute', { token: plan.token, phrase, acknowledgedRisk });
        state.snapshot = null;
        render();
        message('Operation complete. Scan again to see the current driver state.');
      } finally {
        plan = null;
        lock(false);
      }
    }),
  );
  $('#reveal-driver').addEventListener(
    'click',
    safe(() => api('reveal', { kind: view === 'packages' ? 'package' : 'service', id: selected })),
  );
  $('#open-driver-backup').addEventListener(
    'click',
    safe(() => api('reveal', { kind: 'backup' })),
  );
  $('#driver-guidance').addEventListener(
    'click',
    safe(() => api('documentation', { id: item()?.risk.documentation || 'removal' })),
  );
  $('#driver-confirm-guidance').addEventListener(
    'click',
    safe(() => api('documentation', { id: plan?.item.risk.documentation || 'removal' })),
  );
  const report = () => JSON.stringify({ tool: 'Driver Inspector', ...state.snapshot }, null, 2);
  $('#export-drivers').addEventListener('click', () => {
    if (!state.snapshot) return;
    const url = URL.createObjectURL(new Blob([report()], { type: 'application/json' })),
      link = document.createElement('a');
    link.href = url;
    link.download = 'omnia-drivers.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  $('#copy-drivers').addEventListener(
    'click',
    safe(async () =>
      message(
        (await window.omnia.copyText(report()))
          ? 'Driver report copied.'
          : 'Report too large for the clipboard. Use Export report.',
      ),
    ),
  );
  if (!window.omnia?.drivers) {
    $('#scan-drivers').disabled = true;
    message('Open Driver Inspector in the OMNIA desktop app.');
    return;
  }
  window.omnia.onAdmin((value) => {
    adminEnabled = value.enabled;
    detail();
  });
  safe(async () => {
    const admin = await window.omnia.admin('status');
    adminEnabled = admin.enabled;
    state = await api('status');
    if (!state.supported) {
      $('#scan-drivers').disabled = true;
      message('Driver Inspector currently supports Windows.');
    }
    render();
  })();
})();
