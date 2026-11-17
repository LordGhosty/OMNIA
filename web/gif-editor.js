(() => {
  if (document.body.dataset.tool !== 'gif') return;
  const $ = (id) => document.getElementById(id);
  const canvas = $('gif-composition');
  const image = $('crop-image');
  let media, scheduled;
  const families = { sans: 'Arial, sans-serif', serif: 'Georgia, serif', mono: 'monospace' };
  const bandHeights = { top: null, bottom: null };
  const fontProbe = document.createElement('canvas').getContext('2d');
  const fontSample = 'mmmmmmmmmmlliWW0123456789';
  for (const family of [
    'Arial',
    'Arial Black',
    'Calibri',
    'Cambria',
    'Candara',
    'Comic Sans MS',
    'Consolas',
    'Constantia',
    'Courier New',
    'Georgia',
    'Impact',
    'Palatino Linotype',
    'Segoe UI',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
    'Inter',
    'Roboto',
    'DM Sans',
    'Bricolage Grotesque',
    'Barlow',
    'Playfair Display',
    'Space Mono',
    'Courier Prime',
  ]) {
    const available = ['monospace', 'serif'].some((fallback) => {
      fontProbe.font = `72px ${fallback}`;
      const baseline = fontProbe.measureText(fontSample).width;
      fontProbe.font = `72px "${family}",${fallback}`;
      return fontProbe.measureText(fontSample).width !== baseline;
    });
    if (available) {
      families[family] = `"${family}"`;
      $('gif-font').add(new Option(family, family));
    }
  }
  function controls() {
    const present = Object.fromEntries(
      ['top', 'text', 'bottom'].map((name) => [name, !!$('gif-' + name).value.trim()]),
    );
    for (const element of document.querySelectorAll('[data-gif-controls]'))
      element.hidden = !present[element.dataset.gifControls];
    $('gif-caption-settings').hidden = !present.top && !present.bottom;
    $('gif-text-settings').hidden = !Object.values(present).some(Boolean);
  }
  function effects() {
    return window.omniaGifEffects.settings({
      pixelSize: $('gif-pixel-size').value,
      colorBits: $('gif-color-bits').value,
      pattern: $('gif-pattern').value,
    });
  }

  function wrap(context, text, width) {
    const lines = [];
    for (const paragraph of text.trim().split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const next = line ? line + ' ' + word : word;
        if (context.measureText(next).width <= width) line = next;
        else {
          if (line) lines.push(line);
          line = '';
          for (const letter of Array.from(word)) {
            if (context.measureText(line + letter).width > width && line) {
              lines.push(line);
              line = '';
            }
            line += letter;
          }
        }
      }
      lines.push(line);
    }
    if (lines.length > 6)
      throw Error(
        'Keep each caption or text block to six lines. Reduce the text size or shorten the text.',
      );
    return lines;
  }

  function composition() {
    if (!media) throw Error('Load an image or video first.');
    const crop = window.omniaCrop.value();
    const rotate = Number($('gif-rotate').value);
    const sideways = rotate === 90 || rotate === 270;
    const sourceWidth = sideways ? crop.height : crop.width;
    const sourceHeight = sideways ? crop.width : crop.height;
    const width = Math.min(Number($('gif-width').value), sourceWidth);
    const height = Math.max(1, Math.round((sourceHeight * width) / sourceWidth));
    const size = Math.max(1, Math.round((width * Number($('gif-text-size').value)) / 100));
    const padding = Math.max(1, Math.round(width * 0.035));
    const lineHeight = Math.ceil(size * 1.25);
    const layer = document.createElement('canvas');
    const ctx = layer.getContext('2d');
    const font = `bold ${size}px ${families[$('gif-font').value]}`;
    ctx.font = font;
    const blocks = ['top', 'bottom', 'text'].map((name) => {
      const text = $('gif-' + name).value;
      return { name, lines: text.trim() ? wrap(ctx, text, Math.max(1, width - padding * 2)) : [] };
    });
    const band = (block) =>
      block.lines.length ? block.lines.length * lineHeight + padding * 2 : 0;
    function captionHeight(block) {
      const minimum = band(block);
      const control = $('gif-' + block.name + '-height');
      const value = minimum ? Math.max(minimum, bandHeights[block.name] ?? minimum) : 0;
      control.min = minimum;
      control.value = value;
      $('gif-' + block.name + '-height-value').value = `${value} px`;
      return value;
    }
    const top = captionHeight(blocks[0]),
      bottom = captionHeight(blocks[1]);
    if (height + top + bottom > 4096 || top > 1024 || bottom > 1024)
      throw Error('Choose a smaller output width, a wider crop or shorter captions.');
    if (band(blocks[2]) > height && blocks[2].lines.length)
      throw Error('The overlay text is taller than the image. Reduce its size or shorten it.');
    layer.width = width;
    layer.height = height + top + bottom;
    ctx.fillStyle = $('gif-top-background').value;
    ctx.fillRect(0, 0, width, top);
    ctx.fillStyle = $('gif-bottom-background').value;
    ctx.fillRect(0, top + height, width, bottom);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, size * 0.12);
    for (const block of blocks) {
      const align = $('gif-' + block.name + '-align').value;
      ctx.textAlign = align;
      ctx.fillStyle = $('gif-' + block.name + '-color').value;
      ctx.strokeStyle = $('gif-' + block.name + '-outline-color').value;
      const x = align === 'left' ? padding : align === 'right' ? width - padding : width / 2;
      const textHeight = block.lines.length * lineHeight;
      let y =
        block.name === 'bottom' ? top + height + (bottom - textHeight) / 2 : (top - textHeight) / 2;
      if (block.name === 'text') {
        const position = $('gif-text-position').value;
        const blockHeight = block.lines.length * lineHeight;
        y =
          top +
          (position === 'top'
            ? padding
            : position === 'bottom'
              ? height - padding - blockHeight
              : (height - blockHeight) / 2);
      }
      block.lines.forEach((line, index) => {
        const baseline = y + (index + 0.5) * lineHeight;
        if ($('gif-' + block.name + '-outline').checked) ctx.strokeText(line, x, baseline);
        ctx.fillText(line, x, baseline);
      });
    }
    return {
      layer,
      crop,
      rotate,
      width,
      height,
      top,
      bottom,
      hasText: blocks.some((b) => b.lines.length),
    };
  }

  function render() {
    scheduled = null;
    controls();
    $('gif-composition-area').hidden = !media;
    if (!media) return;
    try {
      const c = composition();
      canvas.width = c.width;
      canvas.height = c.layer.height;
      const ctx = canvas.getContext('2d');
      if (image.complete && image.naturalWidth) {
        ctx.save();
        ctx.translate(c.width / 2, c.top + c.height / 2);
        const flip = $('gif-flip').value;
        ctx.scale(flip === 'horizontal' ? -1 : 1, flip === 'vertical' ? -1 : 1);
        ctx.rotate((c.rotate * Math.PI) / 180);
        const sideways = c.rotate === 90 || c.rotate === 270;
        const w = sideways ? c.height : c.width,
          h = sideways ? c.width : c.height;
        ctx.drawImage(
          image,
          (c.crop.x * image.naturalWidth) / media.width,
          (c.crop.y * image.naturalHeight) / media.height,
          (c.crop.width * image.naturalWidth) / media.width,
          (c.crop.height * image.naturalHeight) / media.height,
          -w / 2,
          -h / 2,
          w,
          h,
        );
        ctx.restore();
        const fx = effects();
        if (fx.pixelSize > 1 || fx.colorBits < 8) {
          const sample = document.createElement('canvas');
          sample.width = Math.ceil(c.width / fx.pixelSize);
          sample.height = Math.ceil(c.height / fx.pixelSize);
          const small = sample.getContext('2d', { willReadFrequently: true });
          small.imageSmoothingEnabled = false;
          small.drawImage(canvas, 0, c.top, c.width, c.height, 0, 0, sample.width, sample.height);
          const pixels = small.getImageData(0, 0, sample.width, sample.height);
          window.omniaGifEffects.quantize(pixels.data, sample.width, fx);
          small.putImageData(pixels, 0, 0);
          ctx.clearRect(0, c.top, c.width, c.height);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sample, 0, c.top, c.width, c.height);
        }
      }
      ctx.drawImage(c.layer, 0, 0);
      const duration = Math.max(
        1 / Number($('gif-fps').value),
        Number($('gif-duration').value) / Number($('gif-speed').value),
      );
      $('gif-composition-status').textContent =
        `${c.width} × ${c.layer.height} px${media.still ? ' · Still image' : ` · ≈ ${duration.toFixed(2)} s per loop`}`;
      $('gif-composition-status').classList.remove('error');
    } catch (error) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      $('gif-composition-status').textContent = error.message;
      $('gif-composition-status').classList.add('error');
    }
  }
  function schedule() {
    if (!scheduled) scheduled = requestAnimationFrame(render);
  }
  document.querySelector('.quality-area').addEventListener('input', schedule);
  for (const name of ['top', 'bottom'])
    $('gif-' + name + '-height').addEventListener('input', () => {
      bandHeights[name] = Number($('gif-' + name + '-height').value);
    });
  document.addEventListener('omnia:crop-change', schedule);
  image.addEventListener('load', schedule);
  $('gif-speed').addEventListener('change', () => {
    $('source-preview').playbackRate = Number($('gif-speed').value);
  });
  window.omniaGif = {
    load(job) {
      media = job.media;
      $('gif-speed-field').hidden = media.still;
      $('source-preview').playbackRate = Number($('gif-speed').value);
      schedule();
    },
    reset() {
      media = null;
      schedule();
    },
    options() {
      const c = composition();
      const options = effects();
      for (const key of ['speed', 'rotate', 'loop', 'colors'])
        options[key] = Number($('gif-' + key).value);
      for (const key of ['flip', 'dither']) options[key] = $('gif-' + key).value;
      if (c.hasText)
        options.overlay = {
          png: c.layer.toDataURL('image/png').split(',')[1],
          top: c.top,
          bottom: c.bottom,
        };
      return options;
    },
  };
})();
