const sharp = require('sharp');

/** Encodes a Windows icon directory with one PNG image per selected square size. */
async function createIcon(file, options = {}, check = () => {}) {
  const sizes = options.sizes ?? [16, 24, 32, 48, 256];
  const fit = options.fit ?? 'contain';
  if (
    !Array.isArray(sizes) ||
    !sizes.length ||
    sizes.length > 7 ||
    new Set(sizes).size !== sizes.length ||
    sizes.some((n) => ![16, 24, 32, 48, 64, 128, 256].includes(n))
  )
    throw Error('Choose one or more icon sizes from 16 to 256 pixels.');
  if (!['contain', 'cover'].includes(fit)) throw Error('Choose fit inside or crop to square.');
  const ordered = [...sizes].sort((a, b) => a - b);
  const images = [];
  for (const size of ordered) {
    check();
    images.push(
      await sharp(file, { limitInputPixels: 40000000, failOn: 'warning' })
        .autoOrient()
        .toColourspace('srgb')
        .ensureAlpha()
        .resize(size, size, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .timeout({ seconds: 20 })
        .toBuffer(),
    );
  }
  check();
  const directory = Buffer.alloc(6 + ordered.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(ordered.length, 4);
  let offset = directory.length;
  ordered.forEach((size, index) => {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  return { bytes: Buffer.concat([directory, ...images]), preview: images.at(-1), sizes: ordered };
}

module.exports = { createIcon };
