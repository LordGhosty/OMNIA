const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
sharp.concurrency(2);
sharp.cache({ memory: 32, files: 0, items: 20 });
const PIXELS = 40_000_000,
  IMAGE_LIMIT = 128 * 1024 * 1024;
let cancelled = false,
  child;
parentPort.on('message', (message) => {
  if (message === 'cancel') {
    cancelled = true;
    child?.kill();
  }
});
const check = () => {
  if (cancelled) throw Error('Cancelled.');
};
const progress = (message, percent) =>
  parentPort.postMessage({ type: 'progress', message, percent });
function command(executable, args, options = {}) {
  check();
  return new Promise((resolve, reject) => {
    child = execFile(
      executable,
      args,
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        child = null;
        if (cancelled) return reject(Error('Cancelled.'));
        if (error)
          return reject(
            Error(
              error.killed
                ? 'The file operation timed out.'
                : String(stderr || error.message).slice(0, 1000),
            ),
          );
        resolve(stdout);
      },
    );
  });
}
async function exif(args, file) {
  const binary = require(
    'exiftool-vendored.' + (process.platform === 'win32' ? 'exe' : 'pl'),
  ).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  // Direct parser process.
  const runtime = path.join(path.dirname(binary), 'exiftool_files');
  const executable = process.platform === 'win32' ? path.join(runtime, 'perl.exe') : binary;
  const prefix = process.platform === 'win32' ? [path.join(runtime, 'exiftool.pl')] : [];
  const env = { ...process.env };
  delete env.PERL5OPT;
  delete env.PERL5LIB;
  delete env.PERLLIB;
  const stdout = await command(
    executable,
    [...prefix, '-config', '', ...args, '-charset', 'filename=UTF8', file],
    { env },
  );
  check();
  return stdout;
}
async function metadata(file) {
  const tags = JSON.parse(await exif(['-json', '-G1', '-s'], file))[0];
  // Working-copy filesystem fields.
  for (const key of Object.keys(tags))
    if (key === 'SourceFile' || key.startsWith('System:')) delete tags[key];
  return tags;
}
const fieldTags = {
  title: 'XMP-dc:Title',
  author: 'XMP-dc:Creator',
  copyright: 'XMP-dc:Rights',
  notes: 'XMP-dc:Description',
};
function fieldsFrom(tags) {
  return Object.fromEntries(
    Object.entries(fieldTags).map(([name, tag]) => [
      name,
      Array.isArray(tags[tag]) ? tags[tag].join(', ') : String(tags[tag] ?? ''),
    ]),
  );
}
async function imageInfo(file) {
  const size = (await fsp.stat(file)).size;
  if (size > IMAGE_LIMIT) throw Error('Images must be smaller than 128 MiB.');
  const m = await sharp(file, { limitInputPixels: PIXELS, failOn: 'warning' }).metadata();
  if (!['jpeg', 'png', 'webp'].includes(m.format)) throw Error('Choose a JPEG, PNG or WebP image.');
  if ((m.pages || 1) > 1)
    throw Error(
      'Animated or multi-page images are not supported here. Use the GIF tool or select a still frame first.',
    );
  const rotated = [5, 6, 7, 8].includes(m.orientation);
  return {
    format: m.format,
    width: rotated ? m.height : m.width,
    height: rotated ? m.width : m.height,
    bytes: size,
    alpha: !!m.hasAlpha,
    orientation: m.orientation || 1,
    profile: m.space,
    hasProfile: !!m.icc,
    depth: m.depth,
  };
}
async function preview(file, destination) {
  await sharp(file, { limitInputPixels: PIXELS, failOn: 'warning' })
    .autoOrient()
    .resize({ width: 1100, height: 750, fit: 'inside', withoutEnlargement: true })
    .png()
    .timeout({ seconds: 20 })
    .toFile(destination);
  check();
}
function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error(`${label} must be between ${min} and ${max}.`);
  return n;
}
async function convert(file, output, opts, info) {
  if (info.depth !== 'uchar')
    throw Error(
      'Image Workshop currently exports 8-bit images. Higher-bit-depth sources can be inspected and have metadata edited, but are not converted.',
    );
  if (!['jpeg', 'png', 'webp'].includes(opts.format))
    throw Error('Choose JPEG, PNG or WebP output.');
  const quality = integer(opts.quality ?? 85, 1, 100, 'Quality'),
    rotation = integer(opts.rotation ?? 0, 0, 270, 'Rotation');
  if (rotation % 90) throw Error('Rotation must be 0, 90, 180 or 270 degrees.');
  let image = sharp(file, { limitInputPixels: PIXELS, failOn: 'warning' }).autoOrient();
  if (opts.crop) {
    const { left, top, width, height } = opts.crop;
    const crop = {
      left: integer(left, 0, info.width - 1, 'Crop left'),
      top: integer(top, 0, info.height - 1, 'Crop top'),
      width: integer(width, 1, info.width, 'Crop width'),
      height: integer(height, 1, info.height, 'Crop height'),
    };
    if (crop.left + crop.width > info.width || crop.top + crop.height > info.height)
      throw Error('The crop extends beyond this image.');
    image = image.extract(crop);
  }
  // Crop before rotation.
  const oriented = await image.png().timeout({ seconds: 20 }).toBuffer();
  check();
  image = sharp(oriented, { limitInputPixels: PIXELS }).rotate(rotation);
  if (opts.flip) image = image.flip();
  if (opts.flop) image = image.flop();
  const width = opts.width ? integer(opts.width, 1, 12000, 'Width') : undefined,
    height = opts.height ? integer(opts.height, 1, 12000, 'Height') : undefined;
  if (width || height)
    image = image.resize({ width, height, fit: 'inside', withoutEnlargement: true });
  if (!opts.strip) image = image.withIccProfile('srgb');
  if (opts.format === 'jpeg') {
    const background = opts.background === 'black' ? '#000000' : '#ffffff';
    image = image.flatten({ background }).jpeg({ quality, mozjpeg: true });
  } else if (opts.format === 'png') image = image.png({ compressionLevel: 9 });
  else image = image.webp({ quality, lossless: !!opts.lossless });
  // Restore metadata after orientation.
  await image.timeout({ seconds: 20 }).toFile(output);
  check();
  if (!opts.strip)
    await exif(
      [
        '-overwrite_original',
        '-TagsFromFile',
        file,
        '-all:all',
        '--ICC_Profile',
        '-Orientation=',
        '-IFD1:all=',
        '-ThumbnailImage=',
        '-PreviewImage=',
        '-ExifImageWidth=',
        '-ExifImageHeight=',
      ],
      output,
    );
  return imageInfo(output);
}
async function inspect(file, name, stat) {
  const handle = await fsp.open(file, 'r');
  let header;
  try {
    const buf = Buffer.alloc(Math.min(stat.size, 262144));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    header = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  check();
  let detected;
  try {
    detected = await (await import('file-type')).fileTypeFromBuffer(header);
  } catch {}
  const text = !header.includes(0) && !header.subarray(0, 4096).toString('utf8').includes('\uFFFD');
  const extension = path.extname(name).slice(1).toLowerCase();
  const aliases = {
    jpg: ['jpg', 'jpeg', 'jpe'],
    tif: ['tif', 'tiff'],
    exe: ['exe', 'dll', 'sys', 'ocx', 'scr', 'cpl'],
    zip: ['zip', 'jar', 'epub', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
  };
  const hash = crypto.createHash('sha256');
  let bytes = 0,
    last = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    check();
    hash.update(chunk);
    bytes += chunk.length;
    if (Date.now() - last > 150) {
      progress(`Hashing ${name}`, Math.round((bytes / Math.max(1, stat.size)) * 95));
      last = Date.now();
    }
  }
  let signature = {
    status: 'Not applicable',
    message: 'Publisher verification is available for Windows executable files.',
  };
  if (process.platform === 'win32' && detected?.ext === 'exe') {
    const ps = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const script =
      '$s=Get-AuthenticodeSignature -LiteralPath $env:OMNIA_INSPECT_FILE; [pscustomobject]@{status=[string]$s.Status;message=$s.StatusMessage;publisher=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress';
    try {
      signature = JSON.parse(
        await command(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
          env: { ...process.env, OMNIA_INSPECT_FILE: file },
        }),
      );
    } catch (error) {
      check();
      signature = { status: 'Unavailable', message: error.message };
    }
  }
  const after = await fsp.stat(file);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino)
    throw Error('This file changed during inspection. Select it again.');
  let image;
  if (['jpg', 'png', 'webp'].includes(detected?.ext) && stat.size <= IMAGE_LIMIT) {
    try {
      image = await imageInfo(file);
    } catch (error) {
      image = { error: error.message };
    }
  }
  return {
    detected: detected || {
      ext: text ? 'text' : 'unknown',
      mime: text ? 'text/plain (heuristic)' : 'Not identified',
    },
    extension,
    mismatch:
      !!detected && !!extension && !(aliases[detected.ext] || [detected.ext]).includes(extension),
    sha256: hash.digest('hex'),
    bytes: stat.size,
    modified: new Date(stat.mtimeMs).toISOString(),
    signature,
    image,
    headerHex:
      header
        .subarray(0, 256)
        .toString('hex')
        .match(/.{1,32}/g)
        ?.join('\n') || '',
    textPreview: text ? header.subarray(0, 2048).toString('utf8') : undefined,
  };
}
async function main() {
  const { action, sources, directory, options = {} } = workerData;
  const results = [];
  for (let index = 0; index < sources.length; index++) {
    check();
    const source = sources[index];
    progress(
      `${index + 1} / ${sources.length} · ${source.name}`,
      Math.round((index / sources.length) * 100),
    );
    const result = { sourceId: source.id, name: source.name };
    try {
      const before = await fsp.stat(source.path);
      if (
        !before.isFile() ||
        before.size !== source.size ||
        before.mtimeMs !== source.mtimeMs ||
        before.ino !== source.ino
      )
        throw Error('The selected file changed. Select it again.');
      if (action === 'inspect') result.inspection = await inspect(source.path, source.name, before);
      else {
        if (before.size > IMAGE_LIMIT) throw Error('Images must be smaller than 128 MiB.');
        // Working-copy edits.
        const working = path.join(directory, source.id + '-source' + path.extname(source.name));
        await fsp.copyFile(source.path, working);
        check();
        const after = await fsp.stat(source.path);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw Error('The selected image changed while being read.');
        result.info = await imageInfo(working);
        let final = working;
        if (action === 'convert') {
          const selected = { ...options, crop: options.crops?.[source.id] || null };
          final = path.join(
            directory,
            source.id + '-result.' + (options.format === 'jpeg' ? 'jpg' : options.format),
          );
          result.outputInfo = await convert(working, final, selected, result.info);
          result.output = final;
          result.outputName = path.parse(source.name).name + '-omnia' + path.extname(final);
        } else if (action === 'metadata-write' || action === 'metadata-remove') {
          const ext = { jpeg: '.jpg', png: '.png', webp: '.webp' }[result.info.format];
          final = path.join(directory, source.id + '-metadata' + ext);
          await fsp.copyFile(working, final);
          if (action === 'metadata-write') {
            const tags = { SourceFile: final };
            for (const [key, tag] of Object.entries(fieldTags)) {
              if (typeof options.fields?.[key] !== 'string' || options.fields[key].length > 16000)
                throw Error('Metadata fields must be text, up to 16,000 characters each.');
              tags[tag] = options.fields[key];
            }
            // UTF-8 metadata import.
            const tagFile = path.join(directory, source.id + '-tags.json');
            await fsp.writeFile(tagFile, JSON.stringify([tags]));
            await exif(['-overwrite_original', '-json=' + tagFile], final);
            await fsp.rm(tagFile, { force: true });
          } else {
            if (!['all', 'location'].includes(options.mode))
              throw Error('Choose all metadata or location only.');
            await exif(
              options.mode === 'location'
                ? [
                    '-overwrite_original',
                    '-GPS:all=',
                    '-XMP-exif:GPS*=',
                    '-XMP-iptcExt:Location*=',
                    '-XMP-photoshop:City=',
                    '-XMP-photoshop:State=',
                    '-XMP-photoshop:Country=',
                    '-XMP-iptcCore:Location=',
                    '-IPTC:City=',
                    '-IPTC:Sub-location=',
                    '-IPTC:Province-State=',
                    '-IPTC:Country-PrimaryLocationName=',
                    '-IPTC:Country-PrimaryLocationCode=',
                  ]
                : [
                    '-overwrite_original',
                    '-all=',
                    '-tagsFromFile',
                    '@',
                    '-ICC_Profile',
                    '-Orientation',
                  ],
              final,
            );
          }
          result.output = final;
          result.outputName = path.parse(source.name).name + '-metadata' + ext;
          result.outputInfo = await imageInfo(final);
        }
        if (action.startsWith('metadata')) {
          result.tags = await metadata(final);
          result.fields = fieldsFrom(result.tags);
          if (action === 'metadata-write')
            for (const key of Object.keys(fieldTags))
              if (result.fields[key] !== options.fields[key])
                throw Error(`Could not verify the saved ${key} field.`);
        }
        const previewPath = path.join(directory, source.id + '-preview.png');
        await preview(final, previewPath);
        result.preview = previewPath;
        await fsp.rm(working, { force: true });
      }
      check();
    } catch (error) {
      check();
      delete result.output;
      delete result.outputName;
      result.error = error.message;
    }
    results.push(result);
    parentPort.postMessage({ type: 'item', item: result });
  }
  return results;
}
main()
  .then((results) => parentPort.postMessage({ type: 'done', results }))
  .catch((error) => parentPort.postMessage({ type: 'failed', error: error.message, cancelled }))
  .finally(() => {
    parentPort.close();
  });
