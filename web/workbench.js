(() => {
  const $ = (selector) => document.querySelector(selector),
    tool = document.body.dataset.tool;
  let sources = [],
    results = [],
    active = 0,
    jobId = null,
    busy = false,
    report = null,
    pendingMetadata;
  let selecting = false;
  const crops = {},
    sourceInfos = {};
  const api = (action, data = {}) => {
    if (!window.omnia?.files) throw Error('Open this tool in the OMNIA desktop app.');
    return window.omnia.files(action, { tool, ...data });
  };
  const size = (bytes) =>
    bytes >= 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(2) + ' MiB'
      : (bytes / 1024).toFixed(1) + ' KiB';
  const status = (text) => ($('#file-status').textContent = text);
  const safe =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (error) {
        status(error.message);
      }
    };
  const result = () => results.find((item) => item.sourceId === sources[active]?.id);
  const source = () => sources[active];
  function lock(value) {
    busy = value;
    for (const button of document.querySelectorAll('button'))
      if (!['cancel-file-job', 'metadata-cancel'].includes(button.id)) button.disabled = value;
    for (const input of document.querySelectorAll('input,select,textarea')) input.disabled = value;
    $('#cancel-file-job').hidden = !value;
    $('#cancel-file-job').disabled = false;
    $('#file-progress').hidden = !value;
  }
  function queue() {
    $('#choose-files').classList.toggle('selected', sources.length > 0);
    $('#file-title').textContent = sources.length
      ? sources.length === 1
        ? sources[0].name
        : sources.length + ' images selected'
      : 'Drop your ' + (tool === 'images' ? 'images' : 'file') + ' here';
    $('#file-detail').textContent = sources.length
      ? 'Click to choose ' + (tool === 'images' ? 'different images' : 'a different file')
      : 'or click to browse your computer';
    $('#file-sidebar').hidden = !sources.length;
    $('#file-queue-panel').hidden = !sources.length;
    $('#queue-count').textContent = String(sources.length);
    $('#file-queue').replaceChildren();
    sources.forEach((file, index) => {
      const button = document.createElement('button');
      button.className = 'file-row';
      button.setAttribute('aria-selected', String(index === active));
      button.disabled = busy;
      button.textContent = file.name;
      const small = document.createElement('small'),
        item = results.find((r) => r.sourceId === file.id);
      small.textContent = item?.error || size(file.size) + (item?.output ? ' · ready' : '');
      button.append(small);
      button.addEventListener('click', () => {
        active = index;
        queue();
        render();
      });
      $('#file-queue').append(button);
    });
  }
  function dl(el, entries) {
    el.replaceChildren();
    for (const [key, value] of entries) {
      if (value == null) continue;
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = key;
      dd.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
      el.append(dt, dd);
    }
  }
  function fields() {
    return Object.fromEntries(
      ['title', 'author', 'copyright', 'notes'].map((key) => [key, $('#meta-' + key).value]),
    );
  }
  function metadataTable() {
    const item = result(),
      root = $('#metadata-fields');
    if (!root) return;
    root.replaceChildren();
    const query = $('#metadata-search').value.toLowerCase(),
      groups = new Map();
    let shown = 0,
      truncated = false;
    for (const [key, value] of Object.entries(item?.tags || {})) {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (query && !`${key} ${text}`.toLowerCase().includes(query)) continue;
      if (shown++ >= 500) {
        truncated = true;
        continue;
      }
      const colon = key.indexOf(':'),
        group = colon < 0 ? 'Other' : key.slice(0, colon),
        name = colon < 0 ? key : key.slice(colon + 1);
      if (!groups.has(group)) groups.set(group, []);
      groups
        .get(group)
        .push([
          name,
          text.length > 4096 ? text.slice(0, 4096) + '… (full value in exported report)' : text,
        ]);
    }
    if (!groups.size) {
      root.textContent = 'No matching metadata fields.';
      return;
    }
    for (const [name, entries] of groups) {
      const details = document.createElement('details'),
        summary = document.createElement('summary'),
        list = document.createElement('dl');
      summary.textContent = name + ' · ' + entries.length;
      list.className = 'details-grid';
      dl(list, entries);
      details.open = true;
      details.append(summary, list);
      root.append(details);
    }
    if (truncated) {
      const note = document.createElement('p');
      note.className = 'option-note';
      note.textContent =
        'Showing the first 500 matching fields. Narrow the filter or export the complete report.';
      root.append(note);
    }
  }
  function compare() {
    const expected = $('#expected-checksum').value.trim().toLowerCase();
    $('#checksum-result').textContent = !expected
      ? ''
      : !/^[a-f0-9]{64}$/.test(expected)
        ? 'Enter exactly 64 hexadecimal characters.'
        : expected === result()?.inspection?.sha256
          ? 'MATCH · The SHA-256 values are identical.'
          : 'DOES NOT MATCH · The SHA-256 values differ.';
  }
  function render() {
    const item = result();
    $('#file-result-actions').hidden = !item || !!item.error;
    $('#save-file').hidden = !item?.output;
    $('#save-all-files').hidden = tool !== 'images' || !results.some((r) => r.output);
    if (tool === 'inspector') {
      $('#inspector-results').hidden = !item?.inspection;
      if (!item?.inspection) return;
      const i = item.inspection;
      dl($('#inspection-details'), [
        ['Name', source().name],
        ['Location', source().path],
        ['Identified format', i.detected.ext.toUpperCase()],
        ['Content type', i.detected.mime],
        ['Filename extension', i.extension || 'None'],
        [
          'Extension check',
          i.mismatch
            ? 'Does not match the detected format'
            : i.detected.ext === 'unknown' || i.detected.ext === 'text'
              ? 'Inconclusive'
              : 'No mismatch detected',
        ],
        ['Size', size(i.bytes) + ' · ' + i.bytes + ' bytes'],
        ['Modified', i.modified],
        ['SHA-256', i.sha256],
        ['Signature', i.signature.status],
        ['Publisher', i.signature.publisher],
        ['Certificate thumbprint', i.signature.thumbprint],
        ['Signature details', i.signature.message],
        ['Image dimensions', i.image?.width ? i.image.width + ' × ' + i.image.height : undefined],
        ['Transparency', i.image?.width ? (i.image.alpha ? 'Yes' : 'No') : undefined],
        ['Image inspection', i.image?.error],
      ]);
      $('#header-preview').textContent = i.headerHex;
      $('#text-preview-section').hidden = !i.textPreview;
      $('#text-preview').textContent = i.textPreview || '';
      compare();
      return;
    }
    $('#image-preview-panel').hidden = !item?.preview;
    if (item?.error) {
      status(source().name + ': ' + item.error);
      if ($('#metadata-options')) $('#metadata-options').hidden = true;
      return;
    }
    if (!item) return;
    $('#preview-name').textContent = source().name + (item.output ? ' · output' : '');
    const info = item.outputInfo || item.info;
    $('#preview-size').textContent = info.width + ' × ' + info.height + ' · ' + size(info.bytes);
    $('#image-preview').src = '/api/files/preview/' + item.preview;
    $('#output-summary').textContent = item.output
      ? `Original ${size(item.info.bytes)} → output ${size(info.bytes)} · ${info.format.toUpperCase()}. Save copy to keep this result.`
      : '';
    if (tool === 'images') {
      $('#image-options').hidden = !results.some((r) => r.info && !r.error);
      $('#image-crop').hidden = !!item.output;
      $('#edit-original').hidden = !item.output;
      sourceInfos[item.sourceId] ??= item.info;
      syncCrop();
    } else {
      $('#metadata-options').hidden = false;
      for (const key of ['title', 'author', 'copyright', 'notes'])
        $('#meta-' + key).value = item.fields?.[key] || '';
      metadataTable();
    }
  }
  async function run(operation, options = {}) {
    if (busy) return;
    lock(true);
    $('#file-save-status').textContent = '';
    $('#file-result-actions').hidden = true;
    if ($('#image-preview-panel')) $('#image-preview-panel').hidden = true;
    try {
      const job = await api('start', { operation, options });
      jobId = job.id;
      results = [];
      while (true) {
        const state = await api('status', { id: jobId });
        if (!state) throw Error('The operation is no longer available.');
        status(state.message || state.error || 'Working…');
        $('#file-progress').value = state.percent;
        if (!['running', 'cancelling'].includes(state.state)) {
          results = state.results || [];
          report = {
            tool,
            checkedAt: new Date().toISOString(),
            state: state.state,
            files: results.map((item) => {
              const { preview, output, ...rest } = item;
              return rest;
            }),
          };
          if (state.state === 'error') throw Error(state.error || 'The operation failed.');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    } finally {
      lock(false);
      queue();
      render();
      jobId = null;
    }
  }
  function reset() {
    window.omniaFeedback.clear($('#choose-files'));
    sources = [];
    results = [];
    active = 0;
    jobId = null;
    report = null;
    pendingMetadata = null;
    for (const map of [crops, sourceInfos]) for (const key of Object.keys(map)) delete map[key];
    for (const id of [
      'file-result-actions',
      'image-preview-panel',
      'image-options',
      'metadata-options',
      'inspector-results',
      'image-crop',
      'image-crop-box',
      'edit-original',
    ]) {
      const el = $('#' + id);
      if (el) el.hidden = true;
    }
    $('#image-preview')?.removeAttribute('src');
    for (const id of [
      'metadata-fields',
      'inspection-details',
      'header-preview',
      'text-preview',
      'checksum-result',
      'output-summary',
      'file-save-status',
      'preview-name',
      'preview-size',
    ])
      $('#' + id)?.replaceChildren();
    for (const input of document.querySelectorAll('input,textarea')) {
      input.value = input.defaultValue;
      if (input.type === 'checkbox') input.checked = input.defaultChecked;
    }
    for (const select of document.querySelectorAll('select'))
      select.selectedIndex = Math.max(
        0,
        [...select.options].findIndex((option) => option.defaultSelected),
      );
    $('#output-format')?.dispatchEvent(new Event('change'));
    $('#metadata-confirm')?.close();
    $('#file-progress').value = 0;
    queue();
  }
  async function choose(dropped) {
    if (busy || selecting) {
      const text = 'Finish or cancel the current operation before adding files.';
      status(text);
      window.omniaFeedback.reject($('#choose-files'), text);
      return;
    }
    selecting = true;
    try {
      const files = dropped ? await window.omnia.dropFiles(tool, dropped) : await api('choose');
      if (!files) return;
      reset();
      sources = files;
      queue();
      await run(tool === 'images' ? 'load' : tool === 'metadata' ? 'metadata-read' : 'inspect');
      const rejected = results.filter((item) => item.error);
      if (rejected.length)
        window.omniaFeedback.reject(
          $('#choose-files'),
          `${rejected.length} ${rejected.length === 1 ? 'file rejected' : 'files rejected'}. ${rejected[0].error}`,
        );
    } catch (error) {
      window.omniaFeedback.reject($('#choose-files'), error.message);
      throw error;
    } finally {
      selecting = false;
    }
  }
  $('#choose-files').addEventListener(
    'click',
    safe(() => choose()),
  );
  $('#clear-files').addEventListener(
    'click',
    safe(async () => {
      if (busy || selecting) return;
      lock(true);
      try {
        await api('clear');
        reset();
        status('Cleared. Original files and saved copies are unchanged.');
      } finally {
        lock(false);
      }
    }),
  );
  const dropZone = $('#choose-files');
  let dragDepth = 0;
  const fileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth++;
    if (!busy && !selecting) dropZone.classList.add('dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy || selecting ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!fileDrag(event)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropZone.classList.remove('dragging');
    }
  });
  document.addEventListener(
    'drop',
    safe(async (event) => {
      // File-drop navigation guard.
      event.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove('dragging');
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      if (!window.omnia?.dropFiles) {
        status('Open this tool in the OMNIA desktop app to drop local files.');
        return;
      }
      await choose(files);
    }),
  );
  $('#cancel-file-job').addEventListener(
    'click',
    safe(async () => {
      if (jobId) {
        await api('cancel', { id: jobId });
        $('#cancel-file-job').disabled = true;
        status('Cancelling…');
      }
    }),
  );
  $('#save-file').addEventListener(
    'click',
    safe(async () => {
      const saved = await api('save', { id: result().output });
      if (saved) $('#file-save-status').textContent = 'Saved ' + saved.path;
    }),
  );
  $('#save-all-files').addEventListener(
    'click',
    safe(async () => {
      const saved = await api('save-batch', {
        ids: results.filter((item) => item.output).map((item) => item.output),
      });
      if (saved)
        $('#file-save-status').textContent =
          `Saved ${saved.length} copies. Existing filenames were preserved.`;
    }),
  );
  $('#export-file-report').addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = 'omnia-' + tool + '-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  $('#copy-file-report').addEventListener(
    'click',
    safe(async () => {
      const copied = await window.omnia.copyText(JSON.stringify(report, null, 2));
      $('#file-save-status').textContent = copied
        ? 'Report copied.'
        : 'This report is too large for the clipboard. Use Export report.';
    }),
  );
  if (tool === 'images') {
    $('#edit-original').addEventListener(
      'click',
      safe(() => run('load')),
    );
    function format() {
      const f = $('#output-format').value;
      $('#quality-label').hidden = f === 'png' || (f === 'webp' && $('#image-lossless').checked);
      $('#background-label').hidden = f !== 'jpeg';
      $('#lossless-label').hidden = f !== 'webp';
    }
    $('#output-format').addEventListener('change', format);
    $('#image-lossless').addEventListener('change', format);
    format();
    $('#convert-images').addEventListener(
      'click',
      safe(() =>
        run('convert', {
          format: $('#output-format').value,
          quality: Number($('#image-quality').value),
          width: $('#image-width').value,
          height: $('#image-height').value,
          rotation: Number($('#image-rotation').value),
          flip: $('#image-flip').checked,
          flop: $('#image-flop').checked,
          background: $('#image-background').value,
          strip: $('#strip-metadata').checked,
          lossless: $('#image-lossless').checked,
          crops,
        }),
      ),
    );
    $('#reset-image-crop').addEventListener('click', () => {
      delete crops[source().id];
      $('#crop-ratio').value = 'full';
      syncCrop();
    });
    $('#crop-ratio').addEventListener('change', () => {
      const info = sourceInfos[source().id],
        ratio = Number($('#crop-ratio').value);
      if ($('#crop-ratio').value === 'full') delete crops[source().id];
      else if (ratio) {
        const width = Math.min(info.width, Math.floor(info.height * ratio)),
          height = Math.min(info.height, Math.floor(width / ratio));
        crops[source().id] = {
          left: Math.floor((info.width - width) / 2),
          top: Math.floor((info.height - height) / 2),
          width,
          height,
        };
      }
      syncCrop();
    });
    for (const key of ['left', 'top', 'width', 'height'])
      $('#crop-' + key).addEventListener('change', () => {
        const info = sourceInfos[source().id];
        let left = Math.max(0, Math.min(info.width - 1, Number($('#crop-left').value) || 0)),
          top = Math.max(0, Math.min(info.height - 1, Number($('#crop-top').value) || 0));
        crops[source().id] = {
          left,
          top,
          width: Math.max(1, Math.min(info.width - left, Number($('#crop-width').value) || 1)),
          height: Math.max(1, Math.min(info.height - top, Number($('#crop-height').value) || 1)),
        };
        $('#crop-ratio').value = 'free';
        syncCrop();
      });
    const stage = $('#image-stage');
    let start;
    const point = (event) => {
      const rect = stage.getBoundingClientRect(),
        info = sourceInfos[source().id];
      return {
        x: Math.round(
          Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * info.width,
        ),
        y: Math.round(
          Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * info.height,
        ),
      };
    };
    stage.addEventListener('pointerdown', (event) => {
      if (busy || result()?.output || !sourceInfos[source()?.id]) return;
      event.preventDefault();
      start = point(event);
      stage.setPointerCapture(event.pointerId);
      $('#crop-ratio').value = 'free';
    });
    stage.addEventListener('pointermove', (event) => {
      if (!start) return;
      const p = point(event),
        info = sourceInfos[source().id];
      crops[source().id] = {
        left: Math.min(info.width - 1, Math.min(start.x, p.x)),
        top: Math.min(info.height - 1, Math.min(start.y, p.y)),
        width: Math.max(1, Math.abs(start.x - p.x)),
        height: Math.max(1, Math.abs(start.y - p.y)),
      };
      syncCrop();
    });
    stage.addEventListener('pointerup', () => (start = null));
    stage.addEventListener('pointercancel', () => (start = null));
    $('#image-preview').addEventListener('load', drawCrop);
    new ResizeObserver(drawCrop).observe(stage);
  }
  function syncCrop() {
    if (tool !== 'images' || !sourceInfos[source()?.id]) return;
    const info = sourceInfos[source().id],
      crop = crops[source().id] || { left: 0, top: 0, width: info.width, height: info.height };
    for (const key of ['left', 'top', 'width', 'height']) $('#crop-' + key).value = crop[key];
    drawCrop();
  }
  function drawCrop() {
    if (tool !== 'images') return;
    const box = $('#image-crop-box'),
      crop = crops[source()?.id],
      info = sourceInfos[source()?.id];
    box.hidden = !crop || !!result()?.output;
    if (box.hidden || !info) return;
    Object.assign(box.style, {
      left: (crop.left / info.width) * 100 + '%',
      top: (crop.top / info.height) * 100 + '%',
      width: (crop.width / info.width) * 100 + '%',
      height: (crop.height / info.height) * 100 + '%',
    });
  }
  if (tool === 'metadata') {
    const dialog = $('#metadata-confirm');
    $('#read-metadata').addEventListener(
      'click',
      safe(() => run('metadata-read')),
    );
    $('#write-metadata').addEventListener('click', () => {
      const next = fields(),
        old = result()?.fields || {};
      pendingMetadata = { operation: 'metadata-write', options: { fields: next } };
      $('#metadata-confirm-title').textContent = 'WRITE / REPLACE METADATA';
      $('#metadata-change-preview').textContent = Object.entries(next)
        .map(
          ([key, value]) =>
            key.toUpperCase() +
            '\nBefore: ' +
            (old[key] || '(empty)') +
            '\nAfter: ' +
            (value || '(remove field)'),
        )
        .join('\n\n');
      dialog.showModal();
    });
    $('#remove-metadata').addEventListener('click', () => {
      pendingMetadata = {
        operation: 'metadata-remove',
        options: { mode: $('#remove-mode').value },
      };
      $('#metadata-confirm-title').textContent = 'REMOVE METADATA';
      $('#metadata-change-preview').textContent =
        pendingMetadata.options.mode === 'all'
          ? 'Remove all removable metadata, including notes, camera information, author and location. Keep orientation and the color profile for correct display.'
          : 'Remove known GPS and location fields. Other text, including notes, stays. Location names in arbitrary comments cannot be identified automatically.';
      dialog.showModal();
    });
    $('#metadata-cancel').addEventListener('click', () => dialog.close());
    $('#metadata-apply').addEventListener(
      'click',
      safe(async () => {
        dialog.close();
        await run(pendingMetadata.operation, pendingMetadata.options);
      }),
    );
    $('#metadata-search').addEventListener('input', metadataTable);
  }
  if (tool === 'inspector') {
    $('#expected-checksum').addEventListener('input', compare);
    $('#reveal-file').addEventListener(
      'click',
      safe(() => api('reveal', { id: source().id })),
    );
  }
  if (!window.omnia?.files) {
    $('#choose-files').disabled = true;
    status('Open this tool in the OMNIA desktop app to choose local files.');
  }
})();
