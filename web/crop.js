(() => {
  const $ = (id) => document.getElementById(id);
  if (!$('crop-stage')) return;
  const isGif = document.body.dataset.tool === 'gif',
    maxDuration = isGif ? 30 : 86400;
  let media, crop, dragging;
  let sourceId,
    previewVersion = 0,
    previewQueue = Promise.resolve(),
    previewURL;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  function render() {
    if (!media || !crop) return;
    const box = $('crop-box');
    box.style.left = (100 * crop.x) / media.width + '%';
    box.style.top = (100 * crop.y) / media.height + '%';
    box.style.width = (100 * crop.width) / media.width + '%';
    box.style.height = (100 * crop.height) / media.height + '%';
    for (const key of ['x', 'y', 'width', 'height']) $('crop-' + key).value = crop[key];
    document.dispatchEvent(new Event('omnia:crop-change'));
  }
  function preset() {
    if (!media) return;
    const value = $('crop-preset').value;
    if (value === 'free') return;
    let width = media.width,
      height = media.height;
    if (value !== 'original') {
      const ratio = Number(value);
      if (width / height > ratio) width = Math.round(height * ratio);
      else height = Math.round(width / ratio);
    }
    width = Math.max(1, width);
    height = Math.max(1, height);
    crop = {
      x: Math.floor((media.width - width) / 2),
      y: Math.floor((media.height - height) / 2),
      width,
      height,
    };
    render();
  }
  $('crop-preset').addEventListener('change', preset);
  $('reset-crop').addEventListener('click', () => {
    $('crop-preset').value = 'original';
    preset();
  });
  for (const key of ['x', 'y', 'width', 'height'])
    $('crop-' + key).addEventListener('change', () => {
      if (!media) return;
      const value = Number($('crop-' + key).value);
      if (!Number.isFinite(value)) {
        render();
        return;
      }
      crop[key] = Math.round(value);
      crop.width = clamp(crop.width, 1, media.width);
      crop.height = clamp(crop.height, 1, media.height);
      crop.x = clamp(crop.x, 0, media.width - crop.width);
      crop.y = clamp(crop.y, 0, media.height - crop.height);
      $('crop-preset').value = 'free';
      render();
    });
  $('crop-box').addEventListener('pointerdown', (event) => {
    if (!media || $('gif-start').disabled) return;
    event.preventDefault();
    $('crop-box').setPointerCapture(event.pointerId);
    dragging = {
      x: event.clientX,
      y: event.clientY,
      crop: { ...crop },
      resize: event.target === $('crop-handle'),
    };
  });
  $('crop-box').addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const bounds = $('crop-stage').getBoundingClientRect();
    const dx = Math.round(((event.clientX - dragging.x) * media.width) / bounds.width),
      dy = Math.round(((event.clientY - dragging.y) * media.height) / bounds.height);
    const original = dragging.crop;
    if (dragging.resize) {
      crop.width = clamp(original.width + dx, 1, media.width - crop.x);
      crop.height = clamp(original.height + dy, 1, media.height - crop.y);
      $('crop-preset').value = 'free';
    } else {
      crop.x = clamp(original.x + dx, 0, media.width - crop.width);
      crop.y = clamp(original.y + dy, 0, media.height - crop.height);
    }
    render();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    $('crop-box').addEventListener(event, () => {
      dragging = null;
    });
  $('source-preview').addEventListener('error', () => {
    $('preview-fallback').hidden = false;
  });
  function updateFrame(time) {
    if (!media || media.still || !Number.isFinite(time)) return;
    const version = ++previewVersion,
      id = sourceId;
    $('crop-status').textContent = 'Loading preview…';
    // Serialized preview requests.
    previewQueue = previewQueue
      .catch(() => {})
      .then(async () => {
        if (version !== previewVersion) return;
        try {
          const response = await fetch(`/api/sources/${id}/frame?time=${time}`);
          if (!response.ok) throw new Error('Preview unavailable');
          const blob = await response.blob();
          if (version !== previewVersion) return;
          const url = URL.createObjectURL(blob),
            image = new Image();
          image.src = url;
          try {
            await image.decode();
          } catch (error) {
            URL.revokeObjectURL(url);
            throw error;
          }
          if (version !== previewVersion) {
            URL.revokeObjectURL(url);
            return;
          }
          if (previewURL) URL.revokeObjectURL(previewURL);
          previewURL = url;
          $('crop-image').src = url;
          $('crop-status').textContent = '';
        } catch {
          if (version === previewVersion)
            $('crop-status').textContent =
              'Could not update the preview. Change the start time to try again.';
        }
      });
  }
  $('crop-image').addEventListener('error', () => {
    if (media)
      $('crop-status').textContent = 'Could not load the preview. Reload the source to try again.';
  });
  $('source-preview').addEventListener('seeked', () => {
    if ($('gif-video-preview').open) updateFrame($('source-preview').currentTime);
  });
  $('gif-start').addEventListener('change', () => {
    const value = Number($('gif-start').value);
    if (media && value >= 0 && value < media.duration) {
      $('gif-duration').max = Math.min(maxDuration, media.duration - value).toFixed(2);
      if (Number($('gif-duration').value) > Number($('gif-duration').max))
        $('gif-duration').value = $('gif-duration').max;
      updateFrame(value);
      try {
        $('source-preview').currentTime = value;
      } catch {}
    }
  });
  window.omniaCrop = {
    load(job) {
      ++previewVersion;
      sourceId = job.id;
      media = job.media;
      crop = { x: 0, y: 0, width: media.width, height: media.height };
      if (previewURL) {
        URL.revokeObjectURL(previewURL);
        previewURL = null;
      }
      $('crop-status').textContent = '';
      $('crop-placeholder').hidden = true;
      $('gif-editor').hidden = false;
      $('crop-preset').value = 'original';
      $('gif-start').value = 0;
      $('gif-start').max = Math.max(0, media.duration - 0.1);
      $('gif-duration').max = Math.min(maxDuration, media.duration || maxDuration);
      $('gif-duration').value = isGif ? Math.min(5, media.duration || 5) : media.duration || 0;
      $('crop-image').src = `/api/sources/${job.id}/frame`;
      $('crop-image').alt = media.still
        ? 'Image for crop selection'
        : 'Video frame for crop selection';
      for (const id of ['gif-timing', 'gif-video-preview', 'gif-frame-rate'])
        $(id).hidden = media.still;
      $('gif-options-title').textContent = media.still ? 'CROP & SIZE' : 'TRIM & CROP';
      $('gif-note').textContent = !isGif
        ? 'Crop uses the original frame before rotation.'
        : media.still
          ? 'Still image · Two identical frames · Loops continuously.'
          : 'Up to 30 seconds · Loops continuously · No audio.';
      const preview = $('source-preview');
      preview.pause();
      preview.removeAttribute('src');
      if (!media.still) preview.src = `/api/sources/${job.id}/media`;
      preview.load();
      $('preview-fallback').hidden = true;
      render();
    },
    value: () => ({ ...crop }),
    reset() {
      ++previewVersion;
      sourceId = null;
      media = null;
      crop = null;
      if (previewURL) {
        URL.revokeObjectURL(previewURL);
        previewURL = null;
      }
      $('crop-status').textContent = '';
      $('gif-editor').hidden = true;
      $('crop-placeholder').hidden = false;
      $('source-preview').pause();
      $('source-preview').removeAttribute('src');
      $('source-preview').load();
      $('crop-image').removeAttribute('src');
      $('gif-frame-rate').hidden = false;
      $('gif-options-title').textContent = 'TRIM & CROP';
      $('gif-note').textContent = isGif
        ? 'Up to 30 seconds · Loops continuously · No audio.'
        : 'Crop uses the original frame before rotation.';
    },
  };
})();
