(() => {
  const { $, el, bytes, message, safe, button, download } = systemUI,
    api = (a, d = {}) => window.omnia.diskspace(a, d);
  const colors = {
    images: '#e3bd58',
    video: '#a184c6',
    audio: '#72bca4',
    documents: '#6ba6c8',
    archives: '#d79160',
    applications: '#ce706d',
    other: '#85857f',
  };
  const labels = {
    images: 'Images',
    video: 'Video',
    audio: 'Audio',
    documents: 'Documents',
    archives: 'Archives & disk images',
    applications: 'Applications & components',
    other: 'Other',
  };
  let state = {},
    folder = 0,
    offset = 0,
    current = null,
    polling = false,
    lastRender = 0,
    starting = false,
    revision = 0,
    capacityKey = '';
  function capacityView(size, free) {
    const root = el('div', undefined, 'capacity-view');
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(free)) {
      root.append(el('p', 'Capacity unavailable.', 'option-note'));
      return root;
    }
    free = Math.max(0, Math.min(size, free));
    const bar = el('div', undefined, 'storage-bar'),
      used = el('div', undefined, 'storage-segment volume-used'),
      empty = el('div', undefined, 'storage-segment volume-free');
    used.style.width = (100 * (size - free)) / size + '%';
    empty.style.width = (100 * free) / size + '%';
    used.title = bytes(size - free) + ' used';
    empty.title = bytes(free) + ' free';
    if (free / size >= 0.18) empty.textContent = 'Free';
    bar.append(used, empty);
    bar.setAttribute('role', 'img');
    bar.setAttribute(
      'aria-label',
      bytes(size - free) + ' used, ' + bytes(free) + ' free of ' + bytes(size),
    );
    const legend = el('div', undefined, 'capacity-legend');
    legend.append(
      el('span', bytes(size - free) + ' used'),
      el('strong', bytes(free) + ' free'),
      el('span', bytes(size) + ' total'),
    );
    root.append(bar, legend);
    return root;
  }
  function volumeName(v) {
    return (v.root || 'Volume without a drive letter') + (v.label ? ' · ' + v.label : '');
  }
  function volumeView(v, titled = true) {
    const root = el('div', undefined, 'volume'),
      head = el('div', undefined, 'volume-heading');
    if (titled) {
      head.append(el('strong', volumeName(v)));
      root.append(head);
    }
    root.append(
      capacityView(v.size, v.free),
      el('p', (v.fs || 'No filesystem') + ' · ' + v.health, 'system-subtitle'),
    );
    const scan = button('Analyze ' + (v.root || 'volume'), async () => {
      if (starting || state.scan?.phase === 'scanning') return;
      starting = true;
      render();
      message('Starting scan…');
      try {
        state = await api('volume', { id: v.id });
        reset();
        message('Scanning files. Drive capacity is already available.');
      } finally {
        starting = false;
        render();
      }
    });
    scan.dataset.scanVolume = '';
    scan.dataset.accessible = String(!!v.root && !!v.size);
    scan.disabled = !v.root || !v.size || starting || state.scan?.phase === 'scanning';
    root.append(scan);
    return root;
  }
  function partitionName(v) {
    const type = (v.gptType || '').replace(/[{}]/g, '').toLowerCase();
    if (type === 'de94bba4-06d1-4d40-a16a-bfd50179d6ac' || v.partitionType === 'Recovery')
      return 'Windows recovery volume';
    if (type === 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b') return 'EFI system volume';
    if (v.system) return 'System volume';
    return v.label || 'Volume without a drive letter';
  }
  function disks() {
    const root = $('#disk-cards');
    root.replaceChildren();
    const inventory = state.inventory;
    if (!inventory) return;
    const displayed = new Set();
    const diskList = [...inventory.disks].sort((a, b) => a.number - b.number);
    for (const d of diskList) {
      const all = inventory.volumes.filter((v) => v.disk === d.number);
      const visible = all.filter((v) => v.root).sort((a, b) => a.root.localeCompare(b.root));
      const additional = all.filter((v) => !v.root);
      const card = el('article', undefined, 'disk-card');
      card.append(
        el(
          'h2',
          visible.length === 1
            ? volumeName(visible[0])
            : visible.length
              ? visible.map((v) => v.root).join(' / ')
              : d.name || 'Storage device',
        ),
      );
      const info = el('details', undefined, 'network-details disk-details');
      info.append(
        el(
          'summary',
          'Drive details' +
            (additional.length
              ? ' · ' +
                additional.length +
                ' additional ' +
                (additional.length === 1 ? 'volume' : 'volumes')
              : ''),
        ),
      );
      info.append(
        el('p', 'Disk ' + d.number + ' · ' + d.name, 'system-subtitle'),
        el(
          'p',
          bytes(d.size) +
            ' · ' +
            d.bus +
            ' · ' +
            d.style +
            ' · ' +
            d.health +
            (d.offline ? ' · Offline' : '') +
            (d.readOnly ? ' · Read-only' : ''),
          'system-subtitle',
        ),
      );
      const volumes = el('div', undefined, 'disk-volumes');
      for (const v of all) displayed.add(v.id);
      for (const v of visible) volumes.append(volumeView(v, visible.length !== 1));
      if (!volumes.children.length)
        volumes.append(el('p', 'No accessible drive letters on this device.', 'option-note'));
      if (additional.length) {
        info.append(
          el(
            'p',
            'These volumes are parts of this physical drive, not extra disks. Windows often keeps system and recovery volumes without drive letters.',
            'option-note',
          ),
        );
        for (const v of additional) {
          const row = el('div', undefined, 'partition-detail');
          row.append(
            el('strong', partitionName(v)),
            el(
              'span',
              bytes(v.size) + ' · ' + (v.fs || 'No filesystem') + ' · ' + v.health,
              'system-subtitle',
            ),
          );
          info.append(row);
        }
      }
      card.append(volumes, info);
      root.append(card);
    }
    for (const v of inventory.volumes.filter((v) => !displayed.has(v.id))) {
      const card = el('article', undefined, 'disk-card');
      if (v.root) card.append(volumeView(v));
      else {
        const info = el('details', undefined, 'network-details');
        info.append(
          el('summary', 'Unassigned volume'),
          el('p', partitionName(v) + ' · ' + bytes(v.size), 'option-note'),
        );
        card.append(info);
      }
      root.append(card);
    }
    if (!root.children.length)
      root.append(
        el('p', 'No accessible disks were reported. Choose a folder to scan.', 'option-note'),
      );
  }
  function reset() {
    folder = 0;
    offset = 0;
    current = null;
    lastRender = 0;
    revision++;
    capacityKey = '';
  }
  function bar(categories) {
    const root = $('#category-bar'),
      legend = $('#category-legend');
    root.replaceChildren();
    legend.replaceChildren();
    const total = Object.values(categories || {}).reduce((a, b) => a + b, 0);
    for (const [key, size] of Object.entries(categories || {})) {
      if (!size) continue;
      const part = el('div', undefined, 'storage-segment');
      part.style.width = (100 * size) / total + '%';
      part.style.background = colors[key];
      part.title = labels[key] + ' · ' + bytes(size);
      root.append(part);
      const item = el('span'),
        dot = el('i', undefined, 'legend-key');
      dot.style.background = colors[key];
      item.append(dot, document.createTextNode(labels[key] + ' · ' + bytes(size)));
      legend.append(item);
    }
    root.setAttribute(
      'aria-label',
      total ? 'Scanned logical file size: ' + bytes(total) : 'No files measured yet',
    );
  }
  async function listing() {
    if (!state.scan) return;
    const version = revision,
      id = folder,
      page = offset;
    const result = await api('query', { id, offset: page, sort: $('#disk-sort').value });
    if (version !== revision || id !== folder || page !== offset) return;
    current = result;
    $('#disk-breadcrumbs').replaceChildren();
    for (const b of current.breadcrumbs)
      $('#disk-breadcrumbs').append(
        button(b.name, async () => {
          folder = b.id;
          offset = 0;
          await listing();
        }),
      );
    $('#disk-rows').replaceChildren();
    for (const row of current.rows) {
      const tr = el('tr'),
        name = el('td');
      name.append(
        button((row.kind === 'folder' ? '▸ ' : '') + row.name, async () => {
          if (row.kind === 'folder') {
            folder = row.id;
            offset = 0;
            await listing();
          } else await api('reveal', { id: row.id });
        }),
      );
      const share = current.entry.bytes ? (100 * row.bytes) / current.entry.bytes : 0;
      tr.append(
        name,
        el('td', row.kind === 'folder' ? 'Folder' : labels[row.category]),
        el('td', bytes(row.bytes) + (row.linked ? ' · shared' : ''), 'num'),
        el('td', share.toFixed(1) + '%', 'num'),
      );
      const action = el('td');
      action.append(button('↗', () => api('reveal', { id: row.id })));
      tr.append(action);
      $('#disk-rows').append(tr);
    }
    if (!current.rows.length) {
      const tr = el('tr'),
        td = el('td', 'No measured entries in this folder.');
      td.colSpan = 5;
      tr.append(td);
      $('#disk-rows').append(tr);
    }
    $('#disk-page').textContent = current.total
      ? `${offset + 1}–${Math.min(offset + 200, current.total)} of ${current.total}`
      : '0 entries';
    $('#disk-prev').disabled = !offset;
    $('#disk-next').disabled = offset + 200 >= current.total;
    $('#scan-title').textContent = current.entry.name;
    $('#scan-size').textContent = bytes(current.entry.bytes) + ' found';
    $('#scan-path').textContent = current.entry.path;
    bar(current.categories);
  }
  function render() {
    const s = state.scan,
      active = s?.phase === 'scanning',
      busy = active || starting || state.starting;
    $('#scan-panel').hidden = !s;
    $('#disk-progress').hidden = !active;
    $('#choose-scan-folder').disabled = !!busy;
    $('#clear-scan').disabled = !!busy;
    $('#detect-disks').disabled = !!state.loading || !!starting;
    for (const b of document.querySelectorAll('[data-scan-volume]'))
      b.disabled = !!busy || b.dataset.accessible !== 'true';
    $('#cancel-scan').disabled = !active;
    $('#disk-management').hidden = !state.supported;
    if (!s) return;
    if (!current) {
      $('#scan-title').textContent = s.root;
      $('#scan-path').textContent = s.root;
      $('#scan-size').textContent = bytes(s.bytes) + ' found';
      bar(s.categories);
    }
    const key = JSON.stringify(s.capacity);
    if (capacityKey !== key) {
      capacityKey = key;
      const area = $('#scan-capacity');
      area.replaceChildren(el('h3', 'Drive space', 'storage-heading'));
      if (s.capacity) {
        area.append(capacityView(s.capacity.total, s.capacity.free));
        area.title =
          'Capacity of the volume containing ' +
          s.root +
          ', checked ' +
          new Date(s.capacity.checkedAt).toLocaleString();
      } else
        area.append(
          el(
            'p',
            'Drive capacity is unavailable. The breakdown below contains scanned files only.',
            'option-note',
          ),
        );
    }
    $('#category-heading').textContent = active
      ? 'Files found so far'
      : s.phase === 'complete'
        ? 'Scanned files'
        : 'Scanned files · partial result';
    const phase =
      {
        scanning: 'Scanning',
        complete: 'Scan complete',
        cancelled: 'Scan stopped',
        limited: 'Partial scan',
        error: 'Scan failed',
      }[s.phase] || s.phase;
    $('#scan-metrics').textContent =
      `${phase} · ${s.files.toLocaleString()} files · ${s.folders.toLocaleString()} folders` +
      (s.skipped ? ` · ${s.skipped} items skipped` : '');
    $('#scan-issues').textContent =
      (s.limited ? s.limitReason + '\n' : '') +
      `${s.skipped} items skipped · ${s.links || 0} links skipped · ${s.hardlinks || 0} shared hard links counted once\n` +
      (s.allocated != null
        ? 'Allocated bytes: ' + bytes(s.allocated) + '\n'
        : 'Allocated size is not available; sizes shown are logical.\n') +
      (s.issues || []).map((e) => e.path + ' — ' + e.reason).join('\n');
  }
  async function poll() {
    if (polling || !window.omnia?.diskspace) return;
    polling = true;
    try {
      const previous = state.scan?.phase;
      state = await api('status');
      render();
      const finished = previous === 'scanning' && state.scan?.phase !== 'scanning';
      if (
        state.scan &&
        (!current ||
          finished ||
          (state.scan.phase === 'scanning' && !document.hidden && Date.now() - lastRender > 1500))
      ) {
        await listing();
        lastRender = Date.now();
      }
      if (finished) {
        disks();
        message(
          state.scan.phase === 'complete'
            ? state.scan.skipped || state.scan.links
              ? 'Scan complete. Some entries were skipped; see Scan coverage.'
              : 'Scan complete.'
            : 'Scan ' + state.scan.phase + '. Results are partial.',
        );
      }
    } catch (e) {
      message(e.message);
    } finally {
      polling = false;
    }
  }
  $('#detect-disks').addEventListener(
    'click',
    safe(async () => {
      message('Reading disks and volumes…');
      $('#detect-disks').disabled = true;
      try {
        state = await api('refresh');
        disks();
        message(state.inventory.issues.join(' / ') || 'Choose Analyze to see what takes up space.');
      } finally {
        render();
      }
    }),
  );
  $('#choose-scan-folder').addEventListener(
    'click',
    safe(async () => {
      if (starting || state.scan?.phase === 'scanning') return;
      starting = true;
      render();
      try {
        state = await api('folder');
        reset();
        disks();
      } finally {
        starting = false;
        render();
      }
    }),
  );
  $('#disk-management').addEventListener(
    'click',
    safe(() => api('management')),
  );
  $('#cancel-scan').addEventListener(
    'click',
    safe(() => api('cancel')),
  );
  $('#clear-scan').addEventListener(
    'click',
    safe(async () => {
      state = await api('clear');
      reset();
      render();
      disks();
      message('Scan cleared.');
    }),
  );
  $('#export-scan').addEventListener('click', () =>
    download('omnia-disk-space.json', {
      inventory: state.inventory,
      scan: state.scan,
      folder: current,
    }),
  );
  $('#reveal-scan').addEventListener(
    'click',
    safe(() => api('reveal', { id: folder })),
  );
  $('#disk-sort').addEventListener(
    'change',
    safe(async () => {
      offset = 0;
      await listing();
    }),
  );
  $('#disk-prev').addEventListener(
    'click',
    safe(async () => {
      offset = Math.max(0, offset - 200);
      await listing();
    }),
  );
  $('#disk-next').addEventListener(
    'click',
    safe(async () => {
      offset += 200;
      await listing();
    }),
  );
  if (!window.omnia?.diskspace) {
    message('Open Disk Space in the OMNIA desktop app.');
    return;
  }
  setInterval(poll, 800);
  $('#detect-disks').click();
})();
