const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

function settings(input, media, crop) {
  const speed = Number(input.speed ?? 1);
  const rotate = Number(input.rotate ?? 0);
  const flip = input.flip ?? 'none';
  const loop = Number(input.loop ?? 0);
  const colors = Number(input.colors ?? 256);
  const dither = input.dither ?? 'sierra2_4a';
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4)
    throw Error('Choose a GIF speed from 0.25× to 4×.');
  if (![0, 90, 180, 270].includes(rotate)) throw Error('Invalid GIF rotation.');
  if (!['none', 'horizontal', 'vertical'].includes(flip)) throw Error('Invalid GIF flip.');
  if (!Number.isInteger(loop) || loop < -1 || loop > 99) throw Error('Invalid GIF loop count.');
  if (![64, 128, 256].includes(colors)) throw Error('Invalid GIF palette size.');
  if (!['sierra2_4a', 'bayer', 'none'].includes(dither)) throw Error('Invalid GIF dithering.');
  let width = crop?.width || media?.width || Number(input.width);
  let height = crop?.height || media?.height || width;
  if (rotate === 90 || rotate === 270) [width, height] = [height, width];
  const outputWidth = Math.min(Number(input.width), width);
  const outputHeight = Math.max(1, Math.round((height * outputWidth) / width));
  if (outputHeight > 4096) throw Error('Choose a wider crop or a smaller GIF width.');
  let overlay;
  if (input.overlay != null) {
    const { png, top, bottom } = input.overlay;
    if (![top, bottom].every((n) => Number.isInteger(n) && n >= 0 && n <= 1024))
      throw Error('Invalid caption band size.');
    if (outputHeight + top + bottom > 4096) throw Error('The captioned GIF is too tall.');
    if (typeof png !== 'string' || png.length > 2000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(png))
      throw Error('Invalid GIF text image.');
    const bytes = Buffer.from(png, 'base64');
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== outputWidth ||
      bytes.readUInt32BE(20) !== outputHeight + top + bottom
    )
      throw Error('The text image must match the GIF dimensions.');
    overlay = { png, top, bottom };
  }
  return {
    ...require('../web/gif-effects.js').settings(input),
    speed,
    rotate,
    flip,
    loop,
    colors,
    dither,
    outputWidth,
    outputHeight,
    ...(overlay ? { overlay } : {}),
  };
}

async function writeOverlay(directory, overlay) {
  const file = path.join(directory, 'gif-text.png');
  const image = sharp(Buffer.from(overlay.png, 'base64'), { limitInputPixels: 1280 * 4096 });
  const info = await image.metadata();
  if (info.format !== 'png' || (info.pages || 1) !== 1) throw Error('Invalid GIF text image.');
  await fs.writeFile(file, await image.ensureAlpha().png().toBuffer());
  return file;
}

module.exports = { settings, writeOverlay };
