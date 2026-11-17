(() => {
  function settings(input = {}) {
    const pixelSize = Number(input.pixelSize ?? 1);
    const colorBits = Number(input.colorBits ?? 8);
    const pattern = input.pattern ?? 'none';
    if (!Number.isInteger(pixelSize) || pixelSize < 1 || pixelSize > 64)
      throw Error('Pixel size must be between 1 and 64.');
    if (!Number.isInteger(colorBits) || colorBits < 1 || colorBits > 8)
      throw Error('Colour depth must be between 1 and 8 bits per channel.');
    if (!['none', 'bayer', 'checker', 'lines'].includes(pattern))
      throw Error('Invalid image pattern.');
    return { pixelSize, colorBits, pattern };
  }
  const bayer2 = (x, y) => 2 * (x % 2) + 3 * (y % 2) - 4 * (x % 2) * (y % 2);
  function threshold(x, y, pattern) {
    if (pattern === 'bayer')
      return (4 * bayer2(x, y) + bayer2(Math.floor(x / 2), Math.floor(y / 2)) + 0.5) / 16 - 0.5;
    if (pattern === 'checker') return ((x + y) % 2) * 0.5 - 0.25;
    if (pattern === 'lines') return (y % 2) * 0.5 - 0.25;
    return 0;
  }
  function quantize(pixels, width, options) {
    if (options.colorBits === 8) return;
    const step = 255 / (2 ** options.colorBits - 1);
    for (let i = 0; i < pixels.length; i += 4) {
      const pixel = i / 4;
      const offset = threshold(pixel % width, Math.floor(pixel / width), options.pattern);
      for (let c = 0; c < 3; c++)
        pixels[i + c] = Math.max(
          0,
          Math.min(255, Math.floor(pixels[i + c] / step + 0.5 + offset) * step),
        );
    }
  }
  function filters(options, width, height) {
    const result = [];
    if (options.pixelSize > 1)
      result.push(
        `scale=${Math.ceil(width / options.pixelSize)}:${Math.ceil(height / options.pixelSize)}:flags=neighbor`,
      );
    if (options.colorBits < 8) {
      const step = 255 / (2 ** options.colorBits - 1);
      if (options.pattern === 'none') {
        const expression = `clip(floor(val/${step}+0.5)*${step},0,255)`;
        result.push(`lutrgb=r='${expression}':g='${expression}':b='${expression}'`);
      } else {
        const bayer = (x, y) => `(2*mod(${x},2)+3*mod(${y},2)-4*mod(${x},2)*mod(${y},2))`;
        const offset =
          options.pattern === 'bayer'
            ? `((4*${bayer('X', 'Y')}+${bayer('floor(X/2)', 'floor(Y/2)')}+0.5)/16-0.5)`
            : options.pattern === 'checker'
              ? '(mod(X+Y,2)*0.5-0.25)'
              : '(mod(Y,2)*0.5-0.25)';
        result.push(
          'format=gbrap',
          'geq=' +
            ['r', 'g', 'b']
              .map((c) => `${c}='clip(floor(${c}(X,Y)/${step}+0.5+${offset})*${step},0,255)'`)
              .join(':') +
            ":a='alpha(X,Y)':interpolation=nearest",
          'format=rgba',
        );
      }
    }
    if (options.pixelSize > 1) result.push(`scale=${width}:${height}:flags=neighbor`);
    return result;
  }
  const api = { settings, quantize, filters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.omniaGifEffects = api;
})();
