(() => {
  const $ = (id) => document.getElementById(id);
  let state = { disks: [] },
    plan,
    busy = false;
  const disk = () => state.disks.find((d) => d.id === $('drive-select').value),
    volume = () => disk()?.partitions.find((p) => p.number === Number($('volume-select').value));
  const size = (n) => (n / 1024 ** 3).toFixed(1) + ' GiB';
  const status = (text) => {
    $('drive-status').textContent = text;
  };
  function fields() {
    const d = disk();
    $('drive-info').replaceChildren();
    if (d)
      for (const [label, value] of [
        ['Model', d.name],
        ['Disk number', d.number],
        ['Capacity', size(d.size)],
        ['Serial', d.serial || 'Not reported'],
        ['Partition style', d.style],
        ['State', d.protected ? 'Protected / unavailable' : 'Connected'],
      ]) {
        const dt = document.createElement('dt'),
          dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        $('drive-info').append(dt, dd);
      }
    const old = $('volume-select').value;
    $('volume-select').replaceChildren();
    for (const p of d?.partitions || []) {
      const option = document.createElement('option');
      option.value = p.number;
      option.textContent =
        (p.letter ? p.letter + ':' : 'No letter') +
        ' · ' +
        (p.label || 'Unnamed') +
        ' · ' +
        size(p.size);
      option.selected = String(p.number) === old;
      $('volume-select').append(option);
    }
    $('insertion-action').value = state.actions?.[d?.id] || '';
    volumeFields();
    lock();
  }
  function volumeFields() {
    const p = volume();
    $('volume-info').textContent = p
      ? (p.fileSystem || 'Unformatted') + ' · ' + size(p.free) + ' free'
      : '';
    if (p) $('drive-label').value = p.label || 'OMNIA';
  }
  function lock() {
    for (const element of document.querySelectorAll(
      '.network-panel button,.network-panel input,.network-panel select',
    ))
      element.disabled = busy || state.busy || (!disk() && element.id !== 'refresh-drives');
    $('save-insertion').disabled ||= $('insertion-action').value === 'custom';
    for (const button of document.querySelectorAll('[data-action^="drive-"]'))
      button.disabled ||= !window.omniaAdmin.enabled;
  }
  function render(next) {
    state = next;
    const old = $('drive-select').value;
    $('drive-select').replaceChildren();
    for (const d of state.disks) {
      const option = document.createElement('option');
      option.value = d.id;
      option.textContent = 'Disk ' + d.number + ' · ' + d.name + ' · ' + size(d.size);
      option.selected = d.id === old;
      $('drive-select').append(option);
    }
    status(
      state.error ||
        (!state.disks.length
          ? 'Connect a USB flash drive or external USB disk.'
          : state.busy
            ? 'Working…'
            : 'Connected drives are detected automatically.'),
    );
    fields();
  }
  for (let code = 68; code <= 90; code++) {
    const o = document.createElement('option');
    o.value = String.fromCharCode(code);
    o.textContent = o.value + ':';
    o.selected = o.value === 'X';
    $('drive-letter').append(o);
  }
  $('insertion-action').addEventListener('change', lock);
  $('drive-select').addEventListener('change', fields);
  $('volume-select').addEventListener('change', volumeFields);
  $('refresh-drives').addEventListener('click', () =>
    window.omnia
      .drives('refresh')
      .then(render)
      .catch((e) => status(e.message)),
  );
  document.querySelectorAll('[data-action]').forEach((button) =>
    button.addEventListener('click', async () => {
      const requiresAdmin = button.dataset.action.startsWith('drive-');
      if (busy || state.busy || (requiresAdmin && !window.omniaAdmin.enabled)) return;
      try {
        busy = true;
        lock();
        plan = null;
        $('drive-run').dataset.adminRequired = String(requiresAdmin);
        plan = await window.omniaReview(
          $('drive-confirm'),
          $('drive-run'),
          () =>
            window.omnia.drives('prepare', {
              action: button.dataset.action,
              id: disk()?.id,
              partition: volume()?.number,
              label: $('drive-label').value,
              letter: $('drive-letter').value,
              fileSystem: $('drive-fs').value,
              task: {
                schema: 1,
                name: $('flash-name').value,
                platform: $('flash-platform').value,
                script: $('flash-script').value,
              },
            }),
          (plan) => {
            $('drive-confirm-title').textContent = plan.title;
            $('drive-confirm-target').textContent =
              'Disk ' +
              plan.disk.number +
              ' · ' +
              plan.disk.name +
              ' · ' +
              size(plan.disk.size) +
              ' · serial ' +
              (plan.disk.serial || 'unreported') +
              (plan.partition
                ? ' · Volume ' + (plan.partition.letter || plan.partition.number)
                : '');
            $('drive-confirm-warning').textContent = plan.destructive
              ? 'This permanently erases data. Check the disk above. Type ' +
                plan.phrase +
                ' to continue.'
              : 'Apply this action to the selected USB drive?';
            $('flash-review').hidden = !plan.task;
            $('flash-review').textContent = plan.task
              ? plan.task.name + ' · ' + plan.task.platform + '\n\n' + plan.task.script
              : '';
            if (plan.task)
              $('drive-confirm-warning').textContent =
                'Review this exact script. Creating a task does not authorize it. Authorization allows it to run with your user permissions on later insertions while OMNIA is open.';
            $('erase-label').hidden = !plan.destructive;
            $('erase-phrase').value = '';
          },
          requiresAdmin,
        );
      } catch (e) {
        status(e.message);
      } finally {
        busy = false;
        lock();
      }
    }),
  );
  $('drive-cancel').addEventListener('click', () => {
    plan = null;
    $('drive-confirm').close();
  });
  $('drive-run').addEventListener('click', async () => {
    if (!plan) return;
    const action = plan;
    plan = null;
    $('drive-confirm').close();
    busy = true;
    lock();
    status('Working…');
    try {
      const result = await window.omnia.drives('execute', {
        token: action.token,
        phrase: $('erase-phrase').value,
      });
      status(result.message);
    } catch (e) {
      status(e.message);
    } finally {
      busy = false;
      lock();
    }
  });
  $('save-insertion').addEventListener('click', async () => {
    try {
      await window.omnia.drives('configure', {
        id: disk()?.id,
        action: $('insertion-action').value,
      });
      status('Insertion action saved for this computer.');
    } catch (e) {
      status(e.message);
    }
  });
  if (window.omnia) {
    window.omnia.onAdmin(lock);
    window.omnia
      .admin('status')
      .then(lock)
      .catch(() => {});
    window.omnia.onDrives(render);
    window.omnia.drives('status').then(render);
  } else {
    status('Open External Drives inside OMNIA.');
    document.querySelectorAll('button,select,input').forEach((e) => (e.disabled = true));
  }
})();
