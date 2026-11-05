window.createLocationBrowser = ({ api, changed, error }) => {
  const { el, bytes } = window.systemUI;
  const root = document.querySelector('#location-tree');
  let selected = new Set(),
    busy = false;
  const normalize = (p) => (navigator.platform.startsWith('Win') ? p.toLowerCase() : p);
  const sync = () => {
    for (const box of root.querySelectorAll('input[type=checkbox]')) {
      box.checked = selected.has(normalize(box.dataset.path));
      box.disabled = busy;
    }
  };
  const add = async (paths) => {
    if (busy) return;
    setBusy(true);
    try {
      await changed(await api('select', { paths }));
    } catch (e) {
      error(e.message);
    } finally {
      setBusy(false);
      sync();
    }
  };
  function setBusy(value) {
    busy = value;
    sync();
    document.querySelector('#location-add').disabled = value;
    document.querySelector('#location-path').disabled = value;
  }
  function node(entry) {
    const li = el('li'),
      row = el('div', undefined, 'location-row');
    const toggle = el('button', '›', 'location-expand');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Expand ' + entry.name);
    toggle.setAttribute('aria-expanded', 'false');
    const label = el('label'),
      check = el('input'),
      name = el('span', entry.name);
    check.type = 'checkbox';
    check.dataset.path = entry.path;
    check.checked = selected.has(normalize(entry.path));
    check.disabled = busy;
    label.title =
      entry.path + (entry.size ? ` · ${bytes(entry.free)} free of ${bytes(entry.size)}` : '');
    label.append(check, name);
    check.addEventListener('change', async () => {
      if (busy) {
        sync();
        return;
      }
      if (check.checked) await add([entry.path]);
      else {
        setBusy(true);
        try {
          const path = [...selected].find((p) => p === normalize(entry.path));
          await changed(
            await api('remove', { path: selectedPaths.find((p) => normalize(p) === path) }),
          );
        } catch (e) {
          error(e.message);
        } finally {
          setBusy(false);
          sync();
        }
      }
    });
    const children = el('ul');
    children.hidden = true;
    let loaded = false;
    async function load(offset = 0) {
      const hint = el('li', 'Loading folders…', 'location-hint');
      children.append(hint);
      toggle.disabled = true;
      try {
        const result = await api('folders', { path: entry.path, offset });
        hint.remove();
        for (const entry of result.rows) children.append(node(entry));
        if (!result.total) children.append(el('li', 'No subfolders', 'location-hint'));
        if (offset + result.rows.length < result.total) {
          const more = el('button', 'More folders', 'location-more'),
            item = el('li');
          more.addEventListener('click', () => {
            item.remove();
            void load(offset + result.rows.length);
          });
          item.append(more);
          children.append(item);
        }
        loaded = true;
      } catch (e) {
        hint.textContent = e.message;
      } finally {
        toggle.disabled = false;
      }
    }
    toggle.addEventListener('click', async () => {
      children.hidden = !children.hidden;
      toggle.setAttribute('aria-expanded', String(!children.hidden));
      toggle.setAttribute('aria-label', (children.hidden ? 'Expand ' : 'Collapse ') + entry.name);
      if (!children.hidden && !loaded) {
        children.replaceChildren();
        await load();
      }
    });
    row.append(toggle, label);
    li.append(row, children);
    return li;
  }
  let selectedPaths = [];
  async function refresh() {
    const refresh = document.querySelector('#locations-refresh');
    refresh.disabled = true;
    root.textContent = 'Finding locations…';
    try {
      const data = await api('roots', { part: 'folders' });
      root.replaceChildren();
      function section(title, entries) {
        const section = el('section'),
          list = el('ul');
        section.append(el('h3', title));
        list.append(...entries.map(node));
        section.append(list);
        root.append(section);
      }
      section('Quick access', data.folders);
      const pending = el('p', 'Finding drives…', 'location-hint');
      root.append(pending);
      const drives = await api('roots', { part: 'drives' });
      pending.remove();
      section('This computer', drives.drives);
      if (drives.issue) root.append(el('p', drives.issue, 'location-hint'));
      sync();
    } catch (e) {
      root.textContent = e.message;
    } finally {
      refresh.disabled = false;
    }
  }
  document.querySelector('#locations-refresh').addEventListener('click', refresh);
  document.querySelector('#location-address').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector('#location-path');
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    void add([input.value.trim().replace(/^"(.*)"$/, '$1')]);
  });
  return {
    refresh,
    update(paths, locked) {
      selectedPaths = paths;
      selected = new Set(paths.map(normalize));
      setBusy(locked);
    },
  };
};
