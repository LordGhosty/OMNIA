(() => {
  const $ = (id) => document.getElementById(id),
    speed = document.body.dataset.tool === 'speed';
  let info,
    active = false,
    pollTimer,
    approval,
    reviewing = false,
    currentTab = 'connection',
    lastJob;
  function tab(name) {
    currentTab = name;
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.tab === name));
      button.tabIndex = button.dataset.tab === name ? 0 : -1;
    });
    document
      .querySelectorAll('[data-panel]')
      .forEach((panel) => (panel.hidden = panel.dataset.panel !== name));
    if (!speed)
      document.querySelector('.output-panel').hidden =
        !lastJob || lastJob.kind === 'public' || !(name === 'diagnostics' || name === 'controls');
  }
  const labels = {
    ping: 'Ping',
    trace: 'Trace route',
    pathping: 'Packet-loss trace',
    dns: 'DNS lookup',
    tls: 'TLS certificate',
    port: 'TCP port',
    public: 'Public IP',
    action: 'Network action',
  };
  async function api(route, body) {
    const response = await fetch(
      '/api/network/' + route,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Omnia': '1' },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'The operation failed.');
    return data;
  }
  function status(text, error = false) {
    const element =
      !speed && lastJob?.kind === 'public' ? $('public-status') : $('operation-status');
    element.textContent = text;
    element.classList.toggle('error', error);
  }
  const adapter = () => info?.adapters[Number($('adapter')?.value)];
  function setBusy(busy, kind) {
    active = busy;
    document
      .querySelectorAll('.network-panel button,.network-panel input,.network-panel select')
      .forEach((control) => {
        if (
          !['cancel-network', 'copy-result', 'save-result'].includes(control.id) &&
          !control.dataset.copy
        )
          control.disabled =
            busy ||
            reviewing ||
            control.dataset.unavailable === 'true' ||
            (!!control.dataset.action && !window.omniaAdmin.enabled);
      });
    $('cancel-network').hidden = !busy || kind === 'action';
    $('cancel-network').disabled = false;
    if (!speed) {
      const renew = document.querySelector('[data-action="renew-dhcp"]');
      renew.disabled =
        busy ||
        reviewing ||
        !window.omniaAdmin.enabled ||
        !info?.actionsAvailable ||
        !adapter()?.dhcp;
    }
  }
  const display = (value) =>
    value === null || value === undefined || value === ''
      ? 'Not available'
      : Array.isArray(value)
        ? value.join('\n') || 'None reported'
        : String(value);
  function rows(host, entries) {
    host.replaceChildren();
    for (const [label, value] of entries) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = display(value);
      host.append(dt, dd);
    }
  }
  function renderAdapter() {
    const a = adapter();
    if (!a) return;
    const v4 = a.addresses.find((ip) => ip.family === 'IPv4' && !ip.address.startsWith('127.'));
    $('local-ip').textContent = v4?.address || 'Not available';
    $('network-context').textContent = a.name + ' · ' + a.status + (v4 ? ' · ' + v4.address : '');
    rows($('adapter-details'), [
      ['Status', a.status],
      ['Adapter', a.description || a.name],
      [
        'IPv4',
        a.addresses.filter((ip) => ip.family === 'IPv4').map((ip) => ip.address + '/' + ip.prefix),
      ],
      [
        'IPv6',
        a.addresses.filter((ip) => ip.family === 'IPv6').map((ip) => ip.address + '/' + ip.prefix),
      ],
      ['Gateway', a.gateways],
      ['DNS servers', a.dns],
      ['MAC address', a.mac],
      ['Link speed', a.linkSpeed],
      ['MTU', a.mtu],
      [
        'DHCP',
        a.dhcp === null || a.dhcp === undefined
          ? 'Not reported'
          : a.dhcp
            ? 'Automatic'
            : 'Manual / disabled',
      ],
      ['Route metric', a.metric],
    ]);
    if (v4) $('subnet-cidr').value = v4.address + '/' + v4.prefix;
    $('all-addresses').replaceChildren();
    for (const item of info.adapters) {
      const p = document.createElement('p');
      p.textContent = item.name + ' · ' + item.status;
      const ul = document.createElement('ul');
      for (const address of item.addresses) {
        const li = document.createElement('li');
        li.textContent = address.family + ' · ' + address.address + '/' + address.prefix;
        ul.append(li);
      }
      $('all-addresses').append(p, ul);
    }
    setBusy(active);
  }
  function paintInfo(data, previous) {
    info = data;
    $('adapter').replaceChildren();
    info.adapters.forEach((a, i) => {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = a.name + ' · ' + a.status;
      if (a.name === previous) option.selected = true;
      $('adapter').append(option);
    });
    for (const button of document.querySelectorAll('[data-windows]'))
      button.dataset.unavailable = String(
        !info.actionsAvailable || (button.id === 'network-settings' && !window.omnia),
      );
    $('network-status').textContent =
      info.warning ||
      'Local details · ' + info.hostname + ' · ' + new Date(info.checkedAt).toLocaleTimeString();
    if (!info.actionsAvailable && !info.preliminary)
      $('actions-note').textContent =
        'Windows actions are unavailable on this operating system. Connection details and supported diagnostics remain available.';
    renderAdapter();
  }
  async function refresh(force = true) {
    $('refresh-network').disabled = true;
    try {
      const previous = adapter()?.name;
      if (!info) {
        paintInfo(await api('quick'), previous);
        if (
          window.parent !== window &&
          window.parent.omniaRouter &&
          window.parent.document.body.dataset.activeTool !== 'network'
        )
          await new Promise((resolve) =>
            window.addEventListener('omnia:page-visible', resolve, { once: true }),
          );
      }
      paintInfo(await api('info' + (force ? '?refresh=1' : '')), previous);
    } catch (error) {
      $('network-status').textContent = error.message;
    } finally {
      setBusy(active);
    }
  }
  function speedResult(job) {
    const r = job.result || {},
      number = (value) => (Number.isFinite(value) ? value.toFixed(1) : '—');
    if (r.provider) $('speed-provider-label').textContent = r.provider.toUpperCase();
    $('speed-download').textContent = number(r.downloadMbps);
    $('speed-upload').textContent = number(r.uploadMbps);
    $('speed-latency').textContent = number(r.latencyMs);
    $('speed-jitter').textContent = number(r.jitterMs);
    $('download-bytes-rate').textContent =
      number(r.downloadMbps == null ? null : r.downloadMbps / 8) + ' MB/s';
    $('upload-bytes-rate').textContent =
      number(r.uploadMbps == null ? null : r.uploadMbps / 8) + ' MB/s';
    $('loaded-download').textContent = 'Download: ' + number(r.loadedDownloadMs) + ' ms';
    $('loaded-upload').textContent = 'Upload: ' + number(r.loadedUploadMs) + ' ms';
    $('speed-phase').textContent =
      job.state === 'cancelled'
        ? 'CANCELLED'
        : job.state === 'error'
          ? 'STOPPED'
          : job.phase || 'Starting';
    const latency = job.phase === 'Latency',
      live = latency ? r.latencyMs : job.state === 'done' ? r.downloadMbps : r.liveMbps;
    $('speed-unit').textContent = latency ? 'ms' : 'Mbps';
    $('speed-live').textContent = number(live);
    $('speed-live-bytes').textContent = latency
      ? 'HTTPS round trip'
      : number(live == null ? null : live / 8) +
        ' MB/s' +
        (job.state === 'done' ? ' · average download' : ' · live');
    $('speed-progress').value = job.progress || 0;
    $('speed-transferred').textContent = r.provider
      ? 'Received ' +
        ((r.downloadBytes || 0) / 1e6).toFixed(1) +
        ' MB · Sent ' +
        ((r.uploadBytes || 0) / 1e6).toFixed(1) +
        ' MB' +
        (job.state === 'done'
          ? ' · Measured ' +
            number(r.downloadSeconds) +
            ' s down / ' +
            number(r.uploadSeconds) +
            ' s up.'
          : '')
      : '';
    if (r.downloadCapped || r.uploadCapped)
      $('speed-transferred').textContent +=
        ' Data limit reached; choose Extended for a longer measurement.';
    if (r.downloadProviderLimited || r.uploadProviderLimited)
      $('speed-transferred').textContent +=
        ' Very fast transfers reached the provider’s request pacing limit; throughput may be understated.';
    const canvas = $('speed-chart'),
      ctx = canvas.getContext('2d'),
      samples = r.samples || [],
      peak = Math.max(1, ...samples.map((s) => s.mbps)),
      seconds = Math.max(5, ...samples.map((s) => s.seconds));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#292926';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i * canvas.height) / 4);
      ctx.lineTo(canvas.width, (i * canvas.height) / 4);
      ctx.stroke();
    }
    for (const direction of ['download', 'upload']) {
      ctx.beginPath();
      ctx.strokeStyle = direction === 'download' ? '#dddcd3' : '#8f8f85';
      ctx.lineWidth = 2;
      ctx.setLineDash(direction === 'upload' ? [6, 5] : []);
      samples
        .filter((s) => s.direction === direction)
        .forEach((sample, i) => {
          const x = (sample.seconds / seconds) * canvas.width,
            y = canvas.height - 8 - (sample.mbps / peak) * (canvas.height - 16);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    $('chart-scale').textContent = number(peak) + ' Mbps';
  }
  function renderJob(job) {
    if (!job) return;
    clearTimeout(pollTimer);
    lastJob = job;
    if (speed && job.kind === 'speed') speedResult(job);
    if (!speed) {
      $('operation-title').textContent = (labels[job.kind] || job.kind).toUpperCase();
      document.querySelector('.output-panel').hidden =
        job.kind === 'public' || !['diagnostics', 'controls'].includes(currentTab);
      const detail = job.result;
      $('result-summary').textContent =
        job.state === 'running'
          ? job.kind === 'action'
            ? 'Waiting for Windows…'
            : 'Running ' + (labels[job.kind] || job.kind) + '…'
          : job.state === 'done' && detail
            ? job.kind === 'port'
              ? 'Port ' + detail.port + ' accepted a connection in ' + detail.ms + ' ms.'
              : job.kind === 'tls'
                ? 'Certificate verified · ' +
                  detail.protocol +
                  ' · expires in ' +
                  detail.daysRemaining +
                  ' days'
                : job.kind === 'dns'
                  ? 'DNS records received for ' + detail.host
                  : job.kind === 'action'
                    ? 'Action completed. Refresh Connection to see updated details.'
                    : ''
            : '';
      const result = job.result;
      $('network-output').textContent =
        result?.output ?? (result ? JSON.stringify(result, null, 2) : job.output || '');
      const technical = $('result-technical'),
        fields = $('result-fields');
      const raw = typeof result?.output === 'string' || !!job.output;
      const firstOutput = technical.hidden;
      technical.hidden = !$('network-output').textContent;
      if (technical.dataset.job !== job.id || firstOutput) {
        technical.open = raw;
        technical.dataset.job = job.id || '';
      }
      technical.querySelector('summary').textContent = raw ? 'Command output' : 'Technical details';
      fields.hidden = !result || raw || job.kind === 'public';
      if (result && !raw && job.kind !== 'public')
        rows(
          fields,
          Object.entries(result)
            .filter(([key]) => !['output', 'exitCode'].includes(key))
            .map(([key, value]) => [
              key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
              typeof value === 'object' && value !== null
                ? Array.isArray(value)
                  ? value.map((v) =>
                      typeof v === 'object'
                        ? Object.entries(v)
                            .map(([k, x]) => k + ': ' + x)
                            .join(' · ')
                        : v,
                    )
                  : Object.entries(value)
                      .map(([k, v]) => k + ': ' + v)
                      .join('\n')
                : value,
            ]),
        );
      if (job.kind === 'public' && result) {
        const addresses = result.addresses || [];
        $('public-ip').textContent = addresses.map((a) => a.address).join('\n') || 'Unavailable';
        rows($('public-details'), [
          ...addresses.map((a) => [a.family, a.address]),
          ['Lookup provider', result.provider],
          ['Checked', new Date(result.checkedAt).toLocaleString()],
          ...(result.unavailable?.length ? [['Unavailable', result.unavailable]] : []),
        ]);
        $('public-details').hidden = false;
        $('public-technical').hidden = false;
        $('public-raw').textContent = JSON.stringify(result, null, 2);
      }
    }
    const running = job.state === 'running';
    setBusy(running, job.kind);
    status(
      running
        ? (job.phase || 'Working') + '…'
        : job.state === 'error'
          ? job.error
          : job.state === 'cancelled'
            ? 'Cancelled.'
            : job.result?.exitCode
              ? 'Finished. The system command reported a diagnostic failure; check the output.'
              : 'Complete.',
      job.state === 'error',
    );
    if (running) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 500);
    }
  }
  async function poll() {
    try {
      renderJob(await api('job'));
    } catch (error) {
      setBusy(false);
      status('Lost connection to OMNIA. ' + error.message, true);
    }
  }
  async function run(kind, input = {}) {
    if (active) return;
    renderJob({ kind, state: 'running', phase: 'Starting' });
    try {
      renderJob(await api('run', { kind, ...input }));
    } catch (error) {
      renderJob({ kind, state: 'error', error: error.message });
    }
  }
  $('cancel-network').addEventListener('click', async () => {
    try {
      renderJob(await api('cancel', {}));
    } catch (error) {
      status(error.message, true);
    }
  });
  if (speed) {
    $('speed-provider').addEventListener('change', () => {
      $('speed-provider-label').textContent =
        $('speed-provider').selectedOptions[0].textContent.toUpperCase();
    });
    $('start-speed').addEventListener('click', () =>
      run('speed', { mode: $('speed-mode').value, provider: $('speed-provider').value }),
    );
    const loadServers = () =>
      api('speed-servers')
        .then((servers) => {
          const selected = $('speed-provider').value;
          $('speed-provider').replaceChildren();
          for (const item of [
            { id: 'auto', name: 'Automatic · lowest measured latency' },
            ...servers,
          ]) {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name;
            $('speed-provider').append(option);
          }
          $('speed-provider').value = [...$('speed-provider').options].some(
            (o) => o.value === selected,
          )
            ? selected
            : 'auto';
        })
        .catch(() => {});
    if (
      window.parent !== window &&
      window.parent.omniaRouter &&
      window.parent.document.body.dataset.activeTool !== 'speed'
    )
      window.addEventListener('omnia:page-visible', loadServers, { once: true });
    else void loadServers();
  } else {
    $('refresh-network').addEventListener('click', () => refresh(true));
    document.querySelectorAll('[data-tab]').forEach((button, index) => {
      button.addEventListener('click', () => tab(button.dataset.tab));
      button.addEventListener('keydown', (event) => {
        const all = [...document.querySelectorAll('[data-tab]')];
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % all.length;
        if (event.key === 'ArrowLeft') next = (index + all.length - 1) % all.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = all.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          all[next].focus();
          tab(all[next].dataset.tab);
        }
      });
    });
    $('adapter').addEventListener('change', renderAdapter);
    $('public-lookup').addEventListener('click', () => run('public'));
    document.querySelectorAll('[data-diagnostic]').forEach((button) =>
      button.addEventListener('click', () =>
        run(button.dataset.diagnostic, {
          target: $('network-target').value.trim(),
          port: $('network-port').value,
          record: $('dns-record').value,
          count: Number($('ping-count').value),
          hops: Number($('trace-hops').value),
          family: $('ip-family').value,
          dnsServer: $('dns-server').value.trim(),
        }),
      ),
    );
    document.querySelectorAll('[data-copy]').forEach((button) =>
      button.addEventListener('click', async () => {
        try {
          await copy($(button.dataset.copy).textContent);
          button.textContent = 'Copied';
          setTimeout(() => (button.textContent = 'Copy'), 1500);
        } catch {
          status('Could not copy. Select the text and copy it manually.', true);
        }
      }),
    );
    $('save-result').addEventListener('click', () => {
      const text =
        'OMNIA · ' +
        (labels[lastJob?.kind] || lastJob?.kind || 'Network') +
        ' · ' +
        new Date().toISOString() +
        '\n\n' +
        $('network-output').textContent;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'omnia-network-report.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $('copy-result').addEventListener('click', () =>
      copy($('network-output').textContent).catch(() => status('Could not copy the result.', true)),
    );
    $('calculate-subnet').addEventListener('click', async () => {
      try {
        const s = await api('subnet', { cidr: $('subnet-cidr').value.trim() });
        rows($('subnet-result'), [
          ['Network', s.network + '/' + s.prefix],
          ['Subnet mask', s.mask],
          ['Broadcast', s.broadcast],
          ['First address', s.first],
          ['Last address', s.last],
          ['Total addresses', s.total.toLocaleString()],
          ['Usable addresses', s.usable.toLocaleString()],
        ]);
      } catch (error) {
        status(error.message, true);
      }
    });
    $('network-settings').addEventListener('click', () =>
      window.omnia?.networkSettings().catch((error) => status(error.message, true)),
    );
    document.querySelectorAll('[data-action]').forEach((button) =>
      button.addEventListener('click', async () => {
        if (active || reviewing || !window.omniaAdmin.enabled) return;
        reviewing = true;
        approval = null;
        setBusy(active);
        try {
          approval = await window.omniaReview(
            $('network-confirm'),
            $('confirm-run'),
            () =>
              api('action/prepare', {
                action: button.dataset.action,
                adapter: adapter()?.index,
              }),
            (plan) => {
              $('confirm-title').textContent = plan.title;
              $('confirm-description').textContent = plan.description;
              $('confirm-adapter').textContent = plan.adapter ? 'Adapter: ' + plan.adapter : '';
              $('confirm-dns').textContent = button.dataset.action.startsWith('dns-')
                ? 'Current DNS: ' + (plan.currentDNS.join(', ') || 'None reported')
                : '';
              $('confirm-permission').textContent = 'Using the active administrator session.';
            },
          );
        } catch (error) {
          status(error.message, true);
        } finally {
          reviewing = false;
          setBusy(active);
        }
      }),
    );
    $('confirm-cancel').addEventListener('click', () => {
      approval = null;
      $('network-confirm').close();
    });
    $('confirm-run').addEventListener('click', async () => {
      const plan = approval;
      approval = null;
      $('network-confirm').close();
      if (!plan || !window.omniaAdmin.enabled) return;
      setBusy(true, 'action');
      try {
        renderJob(await api('action/execute', { id: plan.id }));
      } catch (error) {
        setBusy(false);
        status(error.message, true);
      }
    });
    window.omnia?.onAdmin(() => setBusy(active));
    void refresh(false);
  }
  function copy(text) {
    return window.omnia?.copyText
      ? window.omnia.copyText(text)
      : navigator.clipboard.writeText(text);
  }
  window.addEventListener('beforeunload', (event) => {
    if (active) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  void api('job')
    .then((job) => {
      if (job && (job.state === 'running' || (speed && job.kind === 'speed'))) renderJob(job);
    })
    .catch(() => {});
})();
