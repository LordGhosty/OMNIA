(() => {
  const { $, el, bytes, message, safe, button, download } = window.systemUI,
    tool = document.body.dataset.tool;
  const cleanError = (error) =>
    String(error.message || error).replace(
      /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
      '',
    );
  const api = async (action, data = {}) => {
    try {
      return await window.omnia.fileTools(action, { tool, ...data });
    } catch (error) {
      throw Error(cleanError(error));
    }
  };
  let offset = 0,
    total = 0,
    group = null,
    groupOffset = 0,
    groupTotal = 0,
    selected = new Set(),
    state,
    plan,
    planOffset = 0,
    timer,
    loading = false,
    starting = false,
    reviewing = false,
    lastOptions = '',
    previewAfterScan = false,
    examples = [];
  const locations = window.createLocationBrowser({
    api,
    changed: selectionChanged,
    error: (text) => window.omniaFeedback.reject($('#file-drop'), text),
  });
  const action = (id, fn) => $(id)?.addEventListener('click', safe(fn));
  function options() {
    const n = (id) => {
        const v = $(id)?.value;
        return v ? Number(v) * 1024 ** 2 : undefined;
      },
      date = (id, end = false) => {
        const v = $(id)?.value;
        return v ? Date.parse(v + 'T00:00:00Z') + (end ? 86400000 - 1 : 0) : undefined;
      };
    return {
      recursive: $('#file-recursive').checked,
      extensions: $('#filter-extensions').value,
      name: $('#filter-name')?.value,
      match: $('#filter-match')?.value || 'auto',
      kind: $('#filter-kind')?.value || 'files',
      caseSensitive: $('#filter-case')?.checked || false,
      exclude: $('#filter-exclude').value,
      minBytes: n('#filter-min'),
      maxBytes: n('#filter-max'),
      after: date('#filter-after'),
      before: date('#filter-before', true),
    };
  }
  function showState(s) {
    state = s;
    const running = ['scanning', 'comparing'].includes(s.state.phase);
    const scopeKey = JSON.stringify(s.roots);
    if ($('#file-scopes').dataset.paths !== scopeKey) {
      $('#file-scopes').dataset.paths = scopeKey;
      $('#file-scopes').replaceChildren(
        ...s.roots.map((p) => {
          const item = el('li'),
            remove = button('×', async () => selectionChanged(await api('remove', { path: p })));
          remove.setAttribute('aria-label', 'Remove ' + p);
          item.append(el('span', p), remove);
          return item;
        }),
      );
    }
    $('#scope-empty').hidden = !!s.roots.length;
    locations.update(s.roots, running || s.busy);
    for (const control of document.querySelectorAll(
      '#file-scopes button,#choose-files,#choose-folders,#file-drop',
    ))
      control.disabled = running || s.busy;
    $('#file-progress').hidden = !running;
    $('#cancel-files').disabled = !running;
    $('#scan-files').disabled = running || s.busy || !s.roots.length;
    if ($('#rename-preview')) $('#rename-preview').disabled = running || s.busy || !s.roots.length;
    $('#file-export').disabled = running;
    $('#file-sort').disabled = running;
    $('#file-count').textContent =
      tool === 'duplicates'
        ? `${s.groups} groups`
        : `${s.count} ${tool === 'search' ? 'results' : 'files'}`;
    $('#file-coverage').textContent = [
      `Visited: ${s.state.visited || 0} · Matched: ${s.count} · Skipped: ${s.state.skipped || 0}`,
      s.state.partial ? 'Scan limit reached. Narrow the selected folders or filters.' : '',
      s.state.current ? 'Current folder: ' + s.state.current : '',
      ...(s.state.issues || []).map((i) => (i.path ? i.path + ' — ' : '') + i.reason),
    ]
      .filter(Boolean)
      .join('\n');
    if (running) {
      message(
        `${s.state.phase === 'comparing' ? 'Comparing file contents' : 'Searching locations'} · ${(s.state.visited || 0).toLocaleString()} checked · ${(s.state.matched || 0).toLocaleString()} found`,
      );
      schedule();
    } else if (s.state.phase !== 'idle') {
      message(
        s.state.phase === 'error'
          ? s.state.issues?.[0]?.reason || 'The scan stopped. Try again.'
          : `${s.state.phase === 'complete' ? 'Complete' : s.state.phase === 'cancelled' ? 'Cancelled — partial results' : s.state.phase === 'partial' ? 'Result limit reached' : 'Scan again to refresh results'} · ${tool === 'duplicates' ? s.groups + ' duplicate groups' : s.count + (tool === 'search' ? ' results' : ' files')} · ${s.state.skipped || 0} skipped${s.state.partial ? '. Narrow the location or filters to see more.' : ''}`,
      );
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(
      safe(async () => {
        const was = state?.state.phase;
        showState(await api('status'));
        if (
          tool === 'search' ||
          (['scanning', 'comparing'].includes(was) &&
            !['scanning', 'comparing'].includes(state.state.phase))
        ) {
          await render();
        }
        if (previewAfterScan && !['scanning', 'comparing'].includes(state.state.phase)) {
          previewAfterScan = false;
          if (state.state.phase === 'complete') await previewNames();
        }
      }),
      500,
    );
  }
  async function refresh() {
    showState(await api('status'));
    await render();
    if (tool === 'rename') await history();
  }
  async function selectionChanged(s) {
    showState(s);
    offset = 0;
    groupOffset = 0;
    group = null;
    selected.clear();
    previewAfterScan = false;
    window.omniaFeedback.clear($('#file-drop'));
    if ($('#selected-count')) $('#selected-count').textContent = '0 selected';
    if ($('#trash-preview')) $('#trash-preview').disabled = true;
    message(
      s.roots.length
        ? `${s.roots.length} location${s.roots.length === 1 ? '' : 's'} selected. ${tool === 'rename' ? 'Choose how to rename, then preview the names.' : tool === 'search' ? 'Enter a name or pattern, then Search.' : 'Choose Find duplicates to begin.'}`
        : 'Choose a location to begin.',
    );
    await render();
  }
  async function render() {
    const data = await api('query', {
      offset: tool === 'duplicates' && !group ? groupOffset : offset,
      group,
      sort: $('#file-sort').value,
    });
    total = data.total;
    examples = data.rows.slice(0, 3);
    if (tool === 'rename') renameExample();
    groupTotal = data.groupCount;
    $('#file-results').hidden = !state.count;
    $('#file-rows').replaceChildren();
    if (tool === 'duplicates') {
      const groupData = await api('query', { offset: groupOffset });
      $('#duplicate-groups').replaceChildren();
      for (const g of groupData.groups) {
        const b = button(
          `${g.name} · ${g.files.length} copies · ${bytes(g.size)} each`,
          async () => {
            group = g.id;
            offset = 0;
            await render();
          },
        );
        b.setAttribute('aria-pressed', String(g.id === group));
        $('#duplicate-groups').append(b);
      }
      if (!group) {
        $('#file-page').textContent = groupTotal
          ? `${groupOffset + 1}–${Math.min(groupOffset + 100, groupTotal)} of ${groupTotal} groups`
          : 'No matching files';
        $('#file-prev').disabled = groupOffset === 0;
        $('#file-next').disabled = groupOffset + 100 >= groupTotal;
        return;
      }
      $('#duplicate-groups').prepend(
        button('All groups', async () => {
          group = null;
          offset = 0;
          await render();
        }),
      );
    }
    for (const f of data.rows) {
      const row = el('tr');
      if (tool === 'duplicates') {
        const td = el('td'),
          check = el('input');
        check.type = 'checkbox';
        check.checked = selected.has(f.id);
        check.setAttribute('aria-label', 'Select ' + f.path);
        check.addEventListener('change', () => {
          check.checked ? selected.add(f.id) : selected.delete(f.id);
          $('#selected-count').textContent = selected.size + ' selected';
          $('#trash-preview').disabled = selected.size === 0;
        });
        td.append(check);
        row.append(td);
      }
      const name = el('td', f.name);
      name.append(el('span', f.path, 'file-path'));
      const actions = el('td'),
        buttons = el('div', undefined, 'file-actions');
      buttons.append(
        button('Show in folder ↗', () => api('reveal', { id: f.id })),
        button('Copy path', () => window.omnia.copyText(f.path)),
      );
      actions.append(buttons);
      row.append(
        name,
        el('td', f.kind === 'folder' ? 'Folder' : bytes(f.size)),
        el('td', new Date(f.modified).toLocaleString()),
        actions,
      );
      $('#file-rows').append(row);
    }
    $('#file-page').textContent = total
      ? `${offset + 1}–${Math.min(offset + 100, total)} of ${total}`
      : 'No files';
    $('#file-prev').disabled = offset === 0;
    $('#file-next').disabled = offset + 100 >= total;
  }
  async function choose(folder) {
    await selectionChanged(
      await window.omniaFeedback.check($('#file-drop'), () => api('choose', { folder })),
    );
  }
  action('#file-drop', () => choose(tool !== 'rename'));
  action('#choose-files', () => choose(false));
  action('#choose-folders', () => choose(true));
  const zone = $('#file-drop');
  for (const name of ['dragenter', 'dragover'])
    zone.addEventListener(name, (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  document.addEventListener(
    'drop',
    safe(async (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      await selectionChanged(
        await window.omniaFeedback.check(zone, async () => {
          try {
            return await window.omnia.dropManagedFiles(tool, files);
          } catch (error) {
            throw Error(cleanError(error));
          }
        }),
      );
    }),
  );
  document.addEventListener('dragover', (e) => e.preventDefault());
  action('#clear-files', async () => {
    showState(await api('clear'));
    previewAfterScan = false;
    window.omniaFeedback.clear(zone);
    for (const input of document.querySelectorAll('.system-form input'))
      if (input.type === 'checkbox') input.checked = input.defaultChecked;
      else input.value = input.defaultValue;
    if ($('#filter-name')) $('#filter-name').value = '';
    $('#location-path').value = '';
    for (const select of document.querySelectorAll('.system-form select')) {
      for (const option of select.options) option.selected = option.defaultSelected;
      if (select.selectedIndex < 0) select.selectedIndex = 0;
    }
    $('#file-recursive').checked = tool !== 'rename';
    if ($('#rename-mode')) {
      $('#rename-mode').value = 'text';
      renameMode();
    }
    offset = 0;
    groupOffset = 0;
    group = null;
    selected.clear();
    $('#selected-count') && ($('#selected-count').textContent = '0 selected');
    if ($('#trash-preview')) $('#trash-preview').disabled = true;
    message('Files cleared.');
    await render();
  });
  async function startScan() {
    if (!state?.roots.length) {
      window.omniaFeedback.reject(zone, 'Choose a location on the left or use Browse folders.');
      return;
    }
    if (starting || ['scanning', 'comparing'].includes(state.state.phase)) return;
    starting = true;
    $('#scan-files').disabled = true;
    offset = 0;
    groupOffset = 0;
    group = null;
    selected.clear();
    $('#selected-count') && ($('#selected-count').textContent = '0 selected');
    try {
      lastOptions = JSON.stringify(options());
      showState(await api('start', { options: options() }));
      await render();
    } catch (error) {
      previewAfterScan = false;
      showState(await api('status'));
      window.omniaFeedback.reject(zone, error.message);
      throw error;
    } finally {
      starting = false;
    }
  }
  action('#scan-files', startScan);
  $('#filter-name')?.addEventListener(
    'keydown',
    safe(async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        await startScan();
      }
    }),
  );
  action('#cancel-files', () => {
    previewAfterScan = false;
    return api('cancel');
  });
  action('#file-prev', async () => {
    tool === 'duplicates' && !group
      ? (groupOffset = Math.max(0, groupOffset - 100))
      : (offset = Math.max(0, offset - 100));
    await render();
  });
  action('#file-next', async () => {
    tool === 'duplicates' && !group ? (groupOffset += 100) : (offset += 100);
    await render();
  });
  $('#file-sort').addEventListener(
    'change',
    safe(async () => {
      offset = 0;
      await render();
    }),
  );
  action('#file-export', async () => {
    const rows = [],
      groups = [];
    const initial = await api('status');
    for (let at = 0; at < initial.count; at += 100) {
      const page = await api('query', { offset: at });
      rows.push(...page.rows);
      groups.push(...(page.groups || []));
    }
    download(`omnia-${tool}.json`, { ...initial, files: rows, duplicateGroups: groups });
  });
  function renderPlan() {
    const rows = plan.rows.slice(planOffset, planOffset + 100);
    $('#file-review-rows').replaceChildren(
      ...rows.map((r) => {
        const div = el('div', undefined, 'file-review-row');
        for (const file of [r.from, r.to.replace(/^Keep: /, '')]) {
          const column = el('div');
          column.append(el('strong', file.split(/[\\/]/).at(-1)), el('span', file));
          div.append(column);
        }
        return div;
      }),
    );
    $('#review-page').textContent =
      `${planOffset + 1}–${Math.min(planOffset + 100, plan.count)} of ${plan.count}`;
    $('#review-prev').disabled = planOffset === 0;
    $('#review-next').disabled = planOffset + 100 >= plan.count;
  }
  function review(p, trash = false) {
    plan = p;
    planOffset = 0;
    const headings = document.querySelectorAll('.file-review-head span');
    headings[0].textContent = trash ? 'REMOVE THIS COPY' : 'CURRENT NAME';
    headings[1].textContent = trash ? 'KEEP THIS COPY' : 'NEW NAME';
    $('#file-review-summary').textContent = trash
      ? `Move ${p.count} selected copies (${bytes(p.bytes)}) to trash?`
      : `Rename ${p.count} files?`;
    $('#file-review-note').textContent = trash
      ? 'At least one matching copy stays in each group. Restore files through the system trash.'
      : 'Existing files will not be overwritten. Undo is available in rename history.';
    $('#review-apply').textContent = trash ? 'Move to trash' : 'Apply names';
    $('#file-review-error').textContent = '';
    renderPlan();
    $('#file-review').showModal();
  }
  action('#review-prev', () => {
    planOffset -= 100;
    renderPlan();
  });
  action('#review-next', () => {
    planOffset += 100;
    renderPlan();
  });
  action('#review-cancel', () => $('#file-review').close());
  function renameRules() {
    const mode = $('#rename-mode').value;
    const rules = Object.fromEntries(
      ['pattern', 'prefix', 'suffix', 'find', 'replace', 'case'].map((k) => [
        k,
        $('#rename-' + k).value,
      ]),
    );
    rules.start = Number($('#rename-start').value);
    rules.padding = Number($('#rename-padding').value);
    if (mode !== 'custom') {
      rules.pattern =
        mode === 'number' ? ($('#rename-base').value.trim() || '{name}') + '-{n}' : '{name}';
      if (mode !== 'text') rules.prefix = rules.suffix = '';
      if (mode !== 'replace') rules.find = rules.replace = '';
      if (mode !== 'case') rules.case = 'keep';
    }
    return rules;
  }
  function renameExample() {
    const root = $('#rename-example');
    if (!examples.length) {
      root.textContent =
        'Preview names will load your selection and show the changes before anything is renamed.';
      return;
    }
    const r = renameRules();
    root.replaceChildren();
    for (const [i, file] of examples.entries()) {
      const at = file.name.lastIndexOf('.'),
        ext = at > 0 ? file.name.slice(at) : '';
      let base = ext ? file.name.slice(0, -ext.length) : file.name;
      if (r.find) base = base.split(r.find).join(r.replace || '');
      let name = (r.pattern || '{name}').replace(/\{(name|n|date)\}/g, (_, token) =>
        token === 'name'
          ? base
          : token === 'n'
            ? String(r.start + i).padStart(r.padding, '0')
            : new Date(file.modified).toISOString().slice(0, 10),
      );
      if (r.case === 'lower') name = name.toLowerCase();
      if (r.case === 'upper') name = name.toUpperCase();
      const row = el('div', undefined, 'rename-sample');
      row.append(
        el('span', file.name),
        el('span', '→'),
        el('strong', r.prefix + name + r.suffix + ext),
      );
      root.append(row);
    }
  }
  function renameMode() {
    const mode = $('#rename-mode').value;
    for (const label of document.querySelectorAll('[data-rename-mode]'))
      label.hidden = !label.dataset.renameMode.split(' ').includes(mode);
    renameExample();
  }
  async function previewNames() {
    if (reviewing || starting || ['scanning', 'comparing'].includes(state.state.phase)) return;
    if (
      state.state.phase === 'idle' ||
      state.state.phase === 'stale' ||
      lastOptions !== JSON.stringify(options())
    ) {
      previewAfterScan = true;
      await startScan();
      return;
    }
    reviewing = true;
    $('#rename-preview').disabled = true;
    try {
      review(await api('rename', { rules: renameRules() }));
    } finally {
      reviewing = false;
      $('#rename-preview').disabled = false;
    }
  }
  action('#rename-preview', previewNames);
  $('#rename-mode')?.addEventListener('change', renameMode);
  $('#rename-rules')?.addEventListener('input', renameExample);
  action('#trash-preview', async () => review(await api('trash', { ids: [...selected] }), true));
  action('#review-apply', async () => {
    if (loading) return;
    loading = true;
    $('#review-apply').disabled = true;
    $('#review-cancel').disabled = true;
    try {
      const result = await api('execute', { token: plan.token });
      $('#file-review').close();
      await refresh();
      message(result.message);
      if (result.results) $('#file-coverage').textContent = JSON.stringify(result.results, null, 2);
      selected.clear();
    } catch (e) {
      $('#file-review-error').textContent = e.message;
      if (tool === 'rename') await history();
    } finally {
      loading = false;
      $('#review-apply').disabled = false;
      $('#review-cancel').disabled = false;
    }
  });
  $('#file-review').addEventListener('cancel', (e) => {
    if (loading) e.preventDefault();
  });
  async function history() {
    const rows = await api('history');
    $('#rename-history').replaceChildren(
      ...rows.map((r) => {
        const div = el('div');
        div.append(
          el(
            'span',
            `${new Date(r.date).toLocaleString()} · ${r.count} files · ${r.complete ? 'Complete' : 'Interrupted'}${r.undoOf ? ' · Restore' : ''}`,
          ),
          button('Review undo', async () => review(await api('undo', { id: r.id }))),
        );
        return div;
      }),
    );
    if (!rows.length) $('#rename-history').textContent = 'No rename operations yet.';
  }
  window.addEventListener('omnia:page-visible', safe(refresh));
  safe(refresh)();
  void locations.refresh();
})();
