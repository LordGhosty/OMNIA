(() => {
  const { $, el, message, safe, button, download } = systemUI,
    api = (a, d = {}) => window.omnia.repair(a, d);
  let state = {},
    plan = null,
    admin = false,
    reviewing = false,
    polling = false;
  function render() {
    const job = state.job,
      running = job?.state === 'running';
    $('#repair-result').hidden = !job;
    $('#repair-progress').hidden = !running;
    for (const b of document.querySelectorAll('[data-repair-task]'))
      b.disabled = !!running || reviewing || !admin || !state.supported;
    if (!job) return;
    $('#repair-state').textContent = job.state.toUpperCase();
    $('#repair-title').textContent = job.name;
    const output = $('#repair-output'),
      nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 70;
    output.textContent = job.output || 'Waiting for Windows output…';
    if (nearBottom) output.scrollTop = output.scrollHeight;
    $('#repair-summary').textContent = running
      ? 'Running since ' +
        new Date(job.started).toLocaleTimeString() +
        '. Windows may pause between output updates.'
      : job.error ||
        (job.result?.restartRequired ? 'Windows reports that a restart is required. ' : '') +
          (job.result?.steps || []).map((s) => s.command + ' — exit ' + s.exitCode).join(' / ') +
          ' Review the output for the result.' +
          (job.saveError ? ' Report could not be saved automatically: ' + job.saveError : '');
  }
  async function review(id) {
    if (reviewing || !admin || state.job?.state === 'running') return;
    reviewing = true;
    plan = null;
    render();
    try {
      plan = await window.omniaReview(
        $('#repair-confirm'),
        $('#repair-run'),
        () => api('prepare', { task: id, volumeId: $('#repair-volume').value }),
        (plan) => {
          $('#repair-plan-title').textContent = plan.name;
          $('#repair-plan-description').textContent = plan.description;
          $('#repair-command').textContent = plan.command;
        },
      );
    } finally {
      reviewing = false;
      render();
    }
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      state = await api('status');
      render();
    } catch (e) {
      message(e.message);
    } finally {
      polling = false;
    }
  }
  $('#repair-cancel').addEventListener('click', () => {
    $('#repair-confirm').close();
    plan = null;
  });
  $('#repair-run').addEventListener(
    'click',
    safe(async () => {
      if (!plan || !admin) return;
      const token = plan.token;
      plan = null;
      $('#repair-confirm').close();
      state = await api('execute', { token });
      render();
      $('#repair-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
  );
  $('#repair-export').addEventListener('click', () =>
    download('omnia-windows-repair.json', state.job),
  );
  $('#repair-copy').addEventListener(
    'click',
    safe(async () =>
      message(
        (await window.omnia.copyText((state.job?.output || '').slice(-190000)))
          ? 'Windows output copied.'
          : 'Unable to copy output.',
      ),
    ),
  );
  if (!window.omnia?.repair) {
    message('Open Windows Repair in the OMNIA desktop app.');
    return;
  }
  window.omnia.onAdmin((s) => {
    admin = s.enabled;
    render();
  });
  safe(async () => {
    admin = (await window.omnia.admin('status')).enabled;
    state = await api('status');
    for (const t of state.tasks) {
      const card = el('article', undefined, 'repair-card');
      card.append(
        el('div', t.changes ? 'REPAIR' : 'CHECK', 'eyebrow'),
        el('h2', t.name),
        el('p', t.description),
        el('code', t.command),
      );
      const b = button('Review operation →', () => review(t.id));
      b.dataset.repairTask = t.id;
      card.append(b);
      $('#repair-tasks').append(card);
    }
    render();
    if (!state.supported) {
      message('This tool is available on Windows.');
      return;
    }
    const inventory = await api('volumes');
    $('#repair-volume').replaceChildren(el('option', 'Choose a volume'));
    $('#repair-volume').firstChild.value = '';
    for (const v of inventory.volumes.filter((v) => v.root && v.size)) {
      const o = el('option', v.root + (v.label ? ' · ' + v.label : ''));
      o.value = v.id;
      $('#repair-volume').append(o);
    }
    setInterval(poll, 800);
  })();
})();
