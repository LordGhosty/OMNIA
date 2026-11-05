const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createWorkbench } = require('../src/workbench.cjs');
let root, service, png, jpeg, webp;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-workbench-test-'));
  service = await createWorkbench();
  png = path.join(root, 'sample.png');
  jpeg = path.join(root, 'portrait.jpg');
  webp = path.join(root, 'sample.webp');
  await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 4,
      background: { r: 100, g: 80, b: 60, alpha: 0.5 },
    },
  })
    .png()
    .toFile(png);
  await sharp(png)
    .flatten({ background: '#fff' })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toFile(jpeg);
  await sharp(png).webp({ lossless: true }).toFile(webp);
});
after(async () => {
  await service?.close();
  await fs.rm(root, { recursive: true, force: true });
});
async function run(tool, action, files, options = {}) {
  const selected = await service.select(tool, files);
  const job = await service.start(
    tool,
    action,
    typeof options === 'function' ? options(selected) : options,
  );
  const start = Date.now();
  let state;
  while (Date.now() - start < 45000) {
    state = service.status(job.id);
    if (!['running', 'cancelling'].includes(state.state)) return state;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error('Job timeout: ' + JSON.stringify(state));
}
test('image batch converts real pixels, respects crop dimensions and never overwrites a source', async () => {
  const original = await fs.readFile(png);
  const state = await run('images', 'convert', [png, jpeg], (files) => ({
    format: 'webp',
    quality: 90,
    strip: true,
    width: 40,
    crops: { [files[0].id]: { left: 5, top: 10, width: 60, height: 40 } },
  }));
  assert.equal(state.state, 'done');
  assert.equal(state.results.length, 2);
  for (const result of state.results) assert.equal(result.error, undefined);
  assert.equal(state.results[0].outputInfo.width, 40);
  assert.equal(state.results[0].outputInfo.height, 27);
  assert.equal(state.results[1].info.width, 80);
  assert.equal(state.results[1].info.height, 120);
  assert.deepEqual(await fs.readFile(png), original);
  await assert.rejects(service.save(state.results[0].output, png), /already exists/);
  const folder = path.join(root, 'exports');
  await fs.mkdir(folder);
  const first = await service.saveBatch(
      state.results.map((r) => r.output),
      folder,
    ),
    second = await service.saveBatch(
      state.results.map((r) => r.output),
      folder,
    );
  assert.notEqual(first[0].path, second[0].path);
  assert.ok((await sharp(first[0].path).metadata()).hasAlpha);
});
test('metadata notes round-trip on PNG, JPEG and WebP, then removal preserves pixels', async () => {
  const fields = {
    title: 'Test title',
    author: 'OMNIA',
    copyright: '© artist',
    notes: 'Personal notes\nΓειά σου 🌍\n<script>not executable</script>',
  };
  for (const file of [png, jpeg, webp]) {
    const original = await fs.readFile(file);
    const state = await run('metadata', 'metadata-write', [file], { fields });
    const item = state.results[0];
    assert.equal(item.error, undefined);
    assert.deepEqual(item.fields, fields);
    const saved = path.join(root, 'notes-' + path.basename(file));
    await service.save(item.output, saved);
    const read = await run('metadata', 'metadata-read', [saved]);
    assert.equal(read.results[0].fields.notes, fields.notes);
    const removed = await run('metadata', 'metadata-remove', [saved], { mode: 'all' });
    assert.equal(removed.results[0].error, undefined);
    assert.equal(removed.results[0].fields.notes, '');
    const clean = path.join(root, 'clean-' + path.basename(file));
    await service.save(removed.results[0].output, clean);
    const a = await sharp(saved).autoOrient().raw().toBuffer(),
      b = await sharp(clean).autoOrient().raw().toBuffer();
    assert.deepEqual(b, a);
    assert.deepEqual(await fs.readFile(file), original);
  }
});
test('metadata fields can be cleared and retain argument-like notes as plain text', async () => {
  const state = await run('metadata', 'metadata-write', [png], {
    fields: { title: '', author: '', copyright: '', notes: '-all=\n@file\n$(echo hi)' },
  });
  assert.equal(state.results[0].error, undefined);
  assert.equal(state.results[0].fields.notes, '-all=\n@file\n$(echo hi)');
});
test('Unicode filenames and metadata survive conversion when preservation is selected', async () => {
  const file = path.join(root, 'σημείωση 🌍.png');
  await fs.copyFile(png, file);
  const fields = {
    title: 'Preserved',
    author: 'Person',
    copyright: '',
    notes: 'A note inside the image',
  };
  const written = await run('metadata', 'metadata-write', [file], { fields });
  assert.equal(written.results[0].error, undefined);
  const annotated = path.join(root, 'annotated.png');
  await service.save(written.results[0].output, annotated);
  const kept = await run('images', 'convert', [annotated], { format: 'webp', strip: false });
  assert.equal(kept.results[0].error, undefined);
  const output = path.join(root, 'preserved.webp');
  await service.save(kept.results[0].output, output);
  const read = await run('metadata', 'metadata-read', [output]);
  assert.equal(read.results[0].fields.notes, fields.notes);
  const cleared = await run('metadata', 'metadata-write', [annotated], {
    fields: { title: '', author: '', copyright: '', notes: '' },
  });
  assert.equal(cleared.results[0].error, undefined);
  assert.equal(cleared.results[0].fields.notes, '');
});
test('animated WebP input is rejected instead of silently dropping frames', async () => {
  const file = path.join(root, 'animated.webp');
  const pixels = Buffer.alloc(4 * 8 * 4);
  for (let p = 0; p < 32; p++) {
    pixels[p * 4 + (p < 16 ? 0 : 2)] = 255;
    pixels[p * 4 + 3] = 255;
  }
  await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
    .webp({ loop: 0, delay: [100, 100] })
    .toFile(file);
  const info = await sharp(file).metadata();
  assert.equal(info.pages, 2);
  const state = await run('images', 'load', [file]);
  assert.match(state.results[0].error, /Animated/);
});
test('known GPS removal removes coordinates while keeping other metadata', async () => {
  const file = path.join(root, 'gps.jpg');
  await sharp(png)
    .jpeg()
    .withExif({
      IFD0: { Artist: 'Camera owner' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '37/1 58/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '23/1 43/1 0/1',
      },
    })
    .toFile(file);
  const read = await run('metadata', 'metadata-read', [file]);
  assert.ok(Object.keys(read.results[0].tags).some((key) => key.includes('GPSLatitude')));
  const state = await run('metadata', 'metadata-remove', [file], { mode: 'location' });
  assert.equal(state.results[0].error, undefined);
  assert.equal(
    Object.keys(state.results[0].tags).some((key) => key.includes('GPSLatitude')),
    false,
  );
  assert.ok(Object.values(state.results[0].tags).includes('Camera owner'));
});
test('higher-bit-depth input is not silently reduced by conversion', async () => {
  const file = path.join(root, 'sixteen-bit.png');
  await sharp(png).toColourspace('rgb16').png().toFile(file);
  assert.equal((await sharp(file).metadata()).depth, 'ushort');
  const state = await run('images', 'convert', [file], { format: 'png' });
  assert.match(state.results[0].error, /Higher-bit-depth/);
  assert.equal(state.results[0].output, undefined);
});
test(
  'Windows executable inspection reads Authenticode without running the selected file',
  { skip: process.platform !== 'win32' },
  async () => {
    const state = await run('inspector', 'inspect', [process.execPath]);
    const item = state.results[0];
    assert.equal(item.error, undefined);
    assert.equal(item.inspection.detected.ext, 'exe');
    assert.notEqual(item.inspection.signature.status, 'Not applicable');
    assert.notEqual(item.inspection.signature.status, 'Unavailable');
  },
);
test('invalid images, oversized crops and unsupported outputs fail without a downloadable result', async () => {
  const fake = path.join(root, 'fake.png');
  await fs.writeFile(fake, 'not an image');
  const state = await run('images', 'load', [fake, png]);
  assert.ok(state.results[0].error);
  assert.equal(state.results[1].error, undefined);
  const crop = await run('images', 'convert', [png], (files) => ({
    format: 'png',
    crops: { [files[0].id]: { left: 110, top: 0, width: 50, height: 20 } },
  }));
  assert.match(crop.results[0].error, /crop/i);
  assert.equal(crop.results[0].output, undefined);
  const format = await run('images', 'convert', [png], { format: '../../evil' });
  assert.match(format.results[0].error, /output/);
  assert.equal(format.results[0].output, undefined);
});
test('file inspection detects renamed contents and produces the correct streaming SHA-256', async () => {
  const disguised = path.join(root, 'image.mp3');
  await fs.copyFile(png, disguised);
  const state = await run('inspector', 'inspect', [disguised]);
  const i = state.results[0].inspection;
  assert.equal(i.detected.ext, 'png');
  assert.equal(i.mismatch, true);
  assert.equal(
    i.sha256,
    crypto
      .createHash('sha256')
      .update(await fs.readFile(disguised))
      .digest('hex'),
  );
  assert.equal(i.image.width, 120);
});
test('unknown and empty files remain inspectable without pretending to identify a binary', async () => {
  const file = path.join(root, 'unknown.bin');
  await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5]));
  const state = await run('inspector', 'inspect', [file]);
  assert.equal(state.results[0].inspection.detected.ext, 'unknown');
  await fs.writeFile(file, '');
  const empty = await run('inspector', 'inspect', [file]);
  assert.equal(empty.results[0].inspection.bytes, 0);
  assert.equal(empty.results[0].inspection.sha256, crypto.createHash('sha256').digest('hex'));
});
test('changed selections and forged actions are rejected; cancellation releases the worker', async () => {
  const file = path.join(root, 'mutable.txt');
  await fs.writeFile(file, 'before');
  await service.select('inspector', [file]);
  await fs.writeFile(file, 'changed contents');
  const job = await service.start('inspector', 'inspect');
  while (service.isBusy()) await new Promise((r) => setTimeout(r, 20));
  assert.match(service.status(job.id).results[0].error, /changed/);
  await assert.rejects(service.start('inspector', 'metadata-write'), /Unsupported/);
  await assert.rejects(service.select('metadata', [png, jpeg]), /one file/);
  await service.select('images', [png, jpeg, webp]);
  const cancellation = await service.start('images', 'convert', { format: 'png' });
  service.cancel(cancellation.id);
  while (service.isBusy()) await new Promise((r) => setTimeout(r, 20));
  assert.equal(service.status(cancellation.id).state, 'cancelled');
});

test('clear removes only the selected tool session and temporary assets, keeping sources and saved copies', async () => {
  const original = await fs.readFile(png);
  const images = await run('images', 'convert', [png], { format: 'webp' });
  const item = images.results[0],
    temporary = service.asset(item.output).path;
  const saved = path.join(root, 'clear-keeps-saved.webp');
  await service.save(item.output, saved);
  const metadata = await run('metadata', 'metadata-read', [png]);
  await service.clear('images');
  assert.equal(service.status(images.id), null);
  assert.equal(service.asset(item.output), undefined);
  assert.equal(service.source('images', item.sourceId), undefined);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  await assert.rejects(service.start('images', 'load'), /Choose a file/);
  assert.ok(service.status(metadata.id));
  assert.ok(service.asset(metadata.results[0].preview));
  assert.deepEqual(await fs.readFile(png), original);
  assert.ok((await fs.stat(saved)).size > 0);
  await service.clear('images');
  await assert.rejects(service.clear('unknown'), /Unknown/);
  const files = await service.select('images', [png]);
  const job = await service.start('images', 'load');
  await assert.rejects(service.clear('images'), /Finish or cancel/);
  while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.status(job.id).results[0].sourceId, files[0].id);
});
