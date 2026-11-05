const $ = (selector) => document.querySelector(selector);
const tool = document.body.dataset.tool;
const allowed = new Set($('#file').accept.split(','));
let sourceMode = 'file',
  source,
  activeJob,
  upload,
  timer,
  readingSource = false,
  busy = false;
const outputFormat = () => (tool === 'mp3' ? $('#output-format').value : tool);
function message(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
function rejectFile(text) {
  message(text, true);
  window.omniaFeedback.reject($('#drop-zone'), text);
}
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not complete the request.');
  return data;
}
const post = (url, data) =>
  api(url, {
    method: 'POST',
    headers: { 'X-Omnia': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
function platformFor(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return '';
    const host = url.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/^m\./, '');
    if (['youtu.be', 'youtube.com', 'music.youtube.com'].includes(host)) return 'YouTube';
    if (host === 'instagram.com') return 'Instagram';
    if (
      host === 'pin.it' ||
      /^(?:[a-z]{2}\.)?pinterest\.(?:com|co\.uk|de|fr|es|it|ca|com\.au|co\.kr|jp|pt|ch|at|se)$/.test(
        host,
      )
    )
      return 'Pinterest';
  } catch {}
  return '';
}
function setBusy(value) {
  busy = value;
  document
    .querySelectorAll(
      '.conversion-panel button,.conversion-panel input,.conversion-panel select,.conversion-panel fieldset',
    )
    .forEach((control) => {
      control.disabled = value;
    });
  $('#cancel').disabled = false;
  $('#cancel').hidden = !value;
  $('#progress-area').hidden = !value;
  $('#convert').disabled = value || !source;
  $('#load-link').disabled = value || !platformFor($('#source-url').value.trim());
}
function clearResult() {
  $('#result').hidden = true;
  $('#convert').hidden = false;
  $('#gif-result').hidden = true;
  $('#gif-result').removeAttribute('src');
  $('#video-result').pause();
  $('#video-result').hidden = true;
  $('#video-result').removeAttribute('src');
  $('#video-result').load();
}
function optionsChanged() {
  if (source && !busy && !$('#result').hidden) {
    clearResult();
    message('Ready.');
  }
}
$('.quality-area').addEventListener('change', optionsChanged);
document.addEventListener('omnia:crop-change', optionsChanged);
function clearSource() {
  readingSource = false;
  if (source) {
    const id = source.id;
    void api(`/api/sources/${id}`, { method: 'DELETE', headers: { 'X-Omnia': '1' } }).catch(
      () => {},
    );
  }
  source = null;
  activeJob = null;
  $('#convert').disabled = true;
  $('#source-summary').hidden = true;
  window.omniaCrop?.reset();
  clearResult();
  const audio = $('#audio-source-preview');
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.hidden = true;
    audio.load();
  }
}
function progress(label, value) {
  $('#progress-label').textContent = label;
  $('#percent').textContent = value === null ? '···' : `${value}%`;
  if (value === null) $('#progress').removeAttribute('value');
  else $('#progress').value = value;
}
function sourceReady(job) {
  if (tool === 'mp3' && !job.media.audio)
    throw new Error('No audio track found. Choose a video with sound or an audio file.');
  if (tool !== 'mp3' && !job.media.video)
    throw new Error('No video track found. Choose a video file.');
  source = job;
  $('#source-summary').hidden = false;
  const seconds = job.media.still
    ? 'Still image'
    : job.media.duration
      ? `${job.media.duration.toFixed(1)} s`
      : '';
  const size = job.media.video ? `${job.media.width} × ${job.media.height}` : '';
  $('#source-summary').textContent = [job.name, seconds, size].filter(Boolean).join(' / ');
  if (tool === 'gif' || tool === 'mp4') window.omniaCrop.load(job);
  if (tool === 'mp3') {
    $('#edit-start').value = 0;
    $('#edit-duration').value = 0;
    $('#edit-start').max = job.media.duration || 86400;
    $('#edit-duration').max = job.media.duration || 86400;
    const audio = $('#audio-source-preview');
    audio.src = `/api/sources/${job.id}/media`;
    audio.hidden = false;
  }
  setBusy(false);
  message('Ready.');
}
async function poll() {
  try {
    const job = await api(`/api/jobs/${activeJob}`);
    if (job.state === 'ready') {
      sourceReady(job);
      readingSource = false;
      return;
    }
    if (job.state === 'done') {
      source = job;
      setBusy(false);
      $('#convert').hidden = true;
      $('#result').hidden = false;
      $('#download').href = `/api/jobs/${job.id}/download`;
      $('#download span').textContent = `Save ${job.format.toUpperCase()}`;
      const preview = `/api/jobs/${job.id}/result?t=${Date.now()}`;
      if (job.format === 'gif') {
        $('#gif-result').src = preview;
        $('#gif-result').hidden = false;
      }
      if (job.format === 'mp4') {
        $('#video-result').src = preview;
        $('#video-result').hidden = false;
      }
      message('Ready to save. Expires in one hour.');
      return;
    }
    if (job.state === 'error') throw new Error(job.error);
    if (job.state === 'cancelled') {
      source = null;
      setBusy(false);
      message('Cancelled.');
      return;
    }
    const label =
      job.state === 'downloading'
        ? `Downloading from ${job.platform}`
        : job.state === 'inspecting'
          ? 'Checking media'
          : 'Converting';
    progress(
      label,
      job.state === 'inspecting' || (job.state === 'converting' && !job.duration)
        ? null
        : job.progress,
    );
    timer = setTimeout(poll, 400);
  } catch (error) {
    source = null;
    setBusy(false);
    const text =
      error instanceof TypeError
        ? 'Lost connection to OMNIA. Reopen this tool from the app.'
        : error.message;
    if (readingSource && sourceMode === 'file') rejectFile(text);
    else message(text, true);
    readingSource = false;
  }
}
function choose(file) {
  if (!file) return;
  if (busy) return rejectFile('Finish or cancel the current operation before adding a file.');
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.has(ext))
    return rejectFile(
      'Wrong file format. Choose a supported ' +
        (tool === 'mp3' ? 'audio or video' : tool === 'gif' ? 'image or video' : 'video') +
        ' file.',
    );
  if (!file.size) return rejectFile('This file is empty. Choose a file with content.');
  if (file.size > 2 * 1024 ** 3) return rejectFile('This file is too large. The limit is 2 GB.');
  window.omniaFeedback.clear($('#drop-zone'));
  clearSource();
  readingSource = true;
  $('#file-title').textContent = file.name;
  $('#file-detail').textContent =
    `${(file.size / 1024 ** 2).toFixed(2)} MB / Click to choose a different file`;
  $('#drop-zone').classList.add('selected');
  setBusy(true);
  progress('Reading file', 0);
  message('');
  upload = new XMLHttpRequest();
  upload.open('POST', `/api/sources?tool=${tool}&name=${encodeURIComponent(file.name)}`);
  upload.setRequestHeader('X-Omnia', '1');
  upload.setRequestHeader('Content-Type', 'application/octet-stream');
  upload.upload.onprogress = (event) => {
    if (event.lengthComputable)
      progress('Reading file', Math.round((event.loaded / event.total) * 100));
  };
  upload.onerror = () => {
    upload = null;
    readingSource = false;
    setBusy(false);
    message('Cannot connect to OMNIA. Reopen the tool from the app.', true);
  };
  upload.onabort = () => {
    upload = null;
    readingSource = false;
    setBusy(false);
    message('Cancelled.');
  };
  upload.onload = () => {
    try {
      const data = JSON.parse(upload.responseText);
      if (upload.status !== 202) throw new Error(data.error || 'Could not read the file.');
      upload = null;
      activeJob = data.id;
      void poll();
    } catch (error) {
      upload = null;
      setBusy(false);
      readingSource = false;
      rejectFile(error.message);
    }
  };
  upload.send(file);
}
$('#drop-zone').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (event) => {
  choose(event.target.files[0]);
  event.target.value = '';
});
for (const name of ['dragenter', 'dragover'])
  $('#drop-zone').addEventListener(name, (event) => {
    event.preventDefault();
    if (!busy) $('#drop-zone').classList.add('dragging');
  });
for (const name of ['dragleave', 'drop'])
  $('#drop-zone').addEventListener(name, (event) => {
    event.preventDefault();
    $('#drop-zone').classList.remove('dragging');
  });
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  if (sourceMode !== 'file' && !busy) $('[data-source="file"]').click();
  if (files.length > 1) rejectFile('Choose one file at a time.');
  else choose(files[0]);
});
document.querySelectorAll('[data-source]').forEach((button) =>
  button.addEventListener('click', () => {
    if (busy || sourceMode === button.dataset.source) return;
    clearSource();
    window.omniaFeedback.clear($('#drop-zone'));
    sourceMode = button.dataset.source;
    document
      .querySelectorAll('[data-source]')
      .forEach((tab) => tab.setAttribute('aria-selected', String(tab === button)));
    $('#file-source').hidden = sourceMode !== 'file';
    $('#link-source').hidden = sourceMode !== 'link';
    if (sourceMode === 'file') {
      $('#file').value = '';
      $('#file-title').textContent = 'Drop your file here';
      $('#file-detail').textContent = 'or click to browse your computer';
      $('#drop-zone').classList.remove('selected');
    }
    message(
      sourceMode === 'file'
        ? 'Choose a file to get started.'
        : 'Paste a video link to get started.',
    );
  }),
);
$('#source-url').addEventListener('input', () => {
  if (source) clearSource();
  const value = $('#source-url').value.trim(),
    platform = platformFor(value);
  $('#platform').textContent = platform;
  $('#load-link').disabled = busy || !platform;
  message(value && !platform ? 'Use a YouTube, Instagram or Pinterest HTTPS video link.' : '');
});
$('#source-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('#load-link').disabled) {
    event.preventDefault();
    $('#load-link').click();
  }
});
$('#load-link').addEventListener('click', async () => {
  if (busy) return;
  clearSource();
  setBusy(true);
  readingSource = true;
  progress('Loading video', null);
  message('');
  try {
    const job = await post('/api/sources', { url: $('#source-url').value.trim(), tool });
    activeJob = job.id;
    void poll();
  } catch (error) {
    setBusy(false);
    message(error.message, true);
  }
});
$('#convert').addEventListener('click', async () => {
  if (busy || !source) return;
  const options = { sourceId: source.id, format: outputFormat() };
  if (tool === 'mp3') options.bitrate = Number($('[name="quality"]:checked').value);
  if (tool === 'mp4') {
    options.height = Number($('#video-height').value);
    options.quality = Number($('#video-quality').value);
  }
  if (tool !== 'gif') {
    for (const key of ['start', 'duration', 'speed', 'volume', 'fadeIn', 'fadeOut'])
      options[key] = Number($('#edit-' + key).value);
    if (tool === 'mp4') {
      options.start = Number($('#gif-start').value);
      options.duration = Number($('#gif-duration').value);
      options.crop = window.omniaCrop.value();
      options.rotate = Number($('#video-rotate').value);
      options.flip = $('#video-flip').value;
      options.mute = $('#video-mute').value === 'yes';
    }
  }
  if (tool === 'gif') {
    for (const key of source.media.still ? ['width'] : ['start', 'duration', 'width', 'fps'])
      options[key] = Number($('#gif-' + key).value);
    options.crop = window.omniaCrop.value();
    if (
      !source.media.still &&
      (!$('#gif-start').checkValidity() || !$('#gif-duration').checkValidity())
    ) {
      message('Choose a valid start time and length within the video (up to 30 seconds).', true);
      return;
    }
  }
  clearResult();
  setBusy(true);
  progress('Preparing conversion', null);
  message('');
  try {
    const job = await post('/api/jobs', options);
    activeJob = job.id;
    void poll();
  } catch (error) {
    setBusy(false);
    message(error.message, true);
  }
});
$('#cancel').addEventListener('click', async () => {
  if (upload) {
    upload.abort();
    return;
  }
  if (!activeJob) return;
  clearTimeout(timer);
  try {
    await post(`/api/jobs/${activeJob}/cancel`, {});
    void poll();
  } catch (error) {
    setBusy(false);
    message(error.message, true);
  }
});
$('#again').addEventListener('click', () => {
  clearSource();
  window.omniaFeedback.clear($('#drop-zone'));
  $('#file').value = '';
  $('#file-title').textContent = 'Drop your file here';
  $('#file-detail').textContent = 'or click to browse your computer';
  $('#drop-zone').classList.remove('selected');
  message(
    sourceMode === 'file' ? 'Choose a file to get started.' : 'Paste a video link to get started.',
  );
});
if (tool === 'mp3')
  $('#output-format').addEventListener('change', () => {
    const format = outputFormat();
    $('.quality-options').hidden = format !== 'mp3';
    $('.more-qualities').hidden = format !== 'mp3';
    $('#lossless-note').hidden = format === 'mp3';
    $('#lossless-note').textContent =
      format === 'flac'
        ? 'Lossless compression. Keeps sample rate and channels; up to 24-bit PCM. For floating-point or 32-bit sources, use WAV to preserve full precision.'
        : 'Uncompressed audio. Keeps the source sample rate, channels and decoded precision.';
    $('#convert span').textContent = `Convert to ${format.toUpperCase()}`;
    clearResult();
    message(source ? 'Ready.' : 'Choose a file or link to get started.');
  });
window.addEventListener('beforeunload', (event) => {
  if (busy) {
    event.preventDefault();
    event.returnValue = '';
  }
});
