const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { startServer, binaries } = require('../src/server.cjs');
const { identifyLink } = require('../src/links.cjs');
let server, cookie, root;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-video-test-'));
  server = await startServer();
  cookie = (await fetch(server.url, { redirect: 'manual' })).headers
    .get('set-cookie')
    .split(';')[0];
  execFileSync(
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=20:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=600:duration=2',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      '-shortest',
      path.join(root, 'source.mp4'),
    ],
    { windowsHide: true },
  );
  execFileSync(
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-display_rotation',
      '90',
      '-i',
      path.join(root, 'source.mp4'),
      '-c',
      'copy',
      '-an',
      path.join(root, 'rotated.mp4'),
    ],
    { windowsHide: true },
  );
  execFileSync(
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=50:duration=1',
      '-c:v',
      'mpeg4',
      path.join(root, 'smooth.mp4'),
    ],
    { windowsHide: true },
  );
});
after(async () => {
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
const req = (route, options = {}) =>
  fetch(server.origin + route, {
    ...options,
    headers: { Cookie: cookie, 'X-Omnia': '1', ...options.headers },
  });
const post = (route, body) =>
  req(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
async function terminal(id) {
  for (let i = 0; i < 400; i++) {
    const job = await (await req(`/api/jobs/${id}`)).json();
    if (['ready', 'done', 'error', 'cancelled'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error('Timed out');
}
async function source(tool, file = 'source.mp4') {
  const response = await req(`/api/sources?tool=${tool}&name=${file}`, {
    method: 'POST',
    body: await fs.readFile(path.join(root, file)),
  });
  assert.equal(response.status, 202);
  const job = await terminal((await response.json()).id);
  assert.equal(job.state, 'ready', job.error);
  return job;
}
async function output(job, format) {
  const response = await req(`/api/jobs/${job.id}/download`);
  assert.equal(response.status, 200);
  const file = path.join(root, job.id + '.' + format);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  return JSON.parse(
    execFileSync(
      binaries().ffprobe,
      [
        '-v',
        'error',
        '-count_frames',
        '-show_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        file,
      ],
      { windowsHide: true },
    ),
  );
}
test('platform detection accepts video links and rejects local URLs, credentials and playlists', () => {
  assert.deepEqual(identifyLink('https://youtu.be/Fixture0001?si=tracking'), {
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=Fixture0001',
  });
  assert.equal(
    identifyLink('https://www.instagram.com/reel/TestReel001/?utm_source=test').platform,
    'Instagram',
  );
  assert.equal(identifyLink('https://www.pinterest.com/pin/123456789/').platform, 'Pinterest');
  assert.equal(identifyLink('https://pin.it/abc123').platform, 'Pinterest');
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1/video',
    'https://youtube.com.evil.test/watch?v=Fixture0001',
    'https://user:secret@youtube.com/watch?v=Fixture0001',
    'https://youtube.com/playlist?list=abc',
    'https://instagram.com/name',
    'https://pinterest.com/board/name',
  ])
    assert.throws(() => identifyLink(url));
});
test('prepared MP4 converts to H.264 with audio and supports byte-range playback', async () => {
  const job = await source('mp4');
  assert.equal(job.media.width, 160);
  assert.equal(job.media.height, 120);
  const partial = await req(`/api/sources/${job.id}/media`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);
  assert.equal(
    (await req(`/api/sources/${job.id}/media`, { headers: { Range: 'bytes=999999999-' } })).status,
    416,
  );
  const response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'mp4',
    height: 720,
    quality: 23,
  });
  assert.equal(response.status, 202);
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const info = await output(done, 'mp4');
  assert.equal(info.streams[0].codec_name, 'h264');
  assert.equal(info.streams[0].width, 160);
  assert.equal(info.streams[0].height, 120);
  assert.equal(info.streams[1].codec_name, 'aac');
});
test('MP4 edits trim, crop, rotate, change speed and remove audio in the encoded output', async () => {
  const job = await source('mp4');
  assert.equal((await req(`/api/sources/${job.id}/frame`)).status, 200);
  const response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'mp4',
    height: 0,
    start: 0.2,
    duration: 1.2,
    speed: 2,
    crop: { x: 20, y: 10, width: 100, height: 80 },
    rotate: 90,
    flip: 'horizontal',
    mute: true,
    fadeIn: 0.1,
    fadeOut: 0.1,
  });
  assert.equal(response.status, 202);
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const result = await output(done, 'mp4'),
    video = result.streams.find((s) => s.codec_type === 'video');
  assert.equal(video.width, 80);
  assert.equal(video.height, 100);
  assert.equal(
    result.streams.some((s) => s.codec_type === 'audio'),
    false,
  );
  assert.ok(Math.abs(Number(result.format.duration) - 0.6) < 0.2);
});
test('audio edits trim and change duration without altering the source file', async () => {
  const original = await fs.readFile(path.join(root, 'source.mp4'));
  const job = await source('mp3');
  assert.equal(
    (
      await post('/api/jobs', {
        sourceId: job.id,
        format: 'wav',
        start: 0.2,
        duration: 1,
        speed: 0.5,
        volume: -6,
        fadeIn: 0.1,
        fadeOut: 0.1,
      })
    ).status,
    202,
  );
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const result = await output(done, 'wav');
  assert.ok(Math.abs(Number(result.format.duration) - 2) < 0.15);
  assert.deepEqual(await fs.readFile(path.join(root, 'source.mp4')), original);
  for (const options of [
    { start: 99 },
    { speed: 0 },
    { rotate: 45 },
    { crop: { x: 155, y: 0, width: 20, height: 30 } },
    { duration: 1, fadeIn: 2 },
  ])
    assert.throws(() =>
      require('../src/media.cjs').optionsFor('mp4', options, {
        duration: 2,
        width: 160,
        height: 120,
      }),
    );
});
test('GIF has the requested crop, frame rate, trim duration and an inline preview', async () => {
  const job = await source('gif');
  assert.equal(job.frame, true);
  assert.equal(
    (await req(`/api/sources/${job.id}/frame`)).headers.get('content-type'),
    'image/jpeg',
  );
  const response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'gif',
    start: 0.5,
    duration: 1,
    width: 96,
    fps: 10,
    crop: { x: 20, y: 10, width: 80, height: 60 },
  });
  assert.equal(response.status, 202);
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const info = await output(done, 'gif');
  assert.equal(info.streams[0].codec_name, 'gif');
  assert.equal(info.streams[0].width, 80);
  assert.equal(info.streams[0].height, 60);
  assert.equal(Number(info.streams[0].nb_read_frames), 10);
  assert.equal(info.streams.length, 1);
  assert.ok(
    Math.abs(info.frames.reduce((sum, frame) => sum + Number(frame.duration_time), 0) - 1) < 0.15,
  );
  const preview = await req(`/api/jobs/${job.id}/result`);
  assert.equal(preview.headers.get('content-type'), 'image/gif');
  assert.equal(preview.headers.get('content-disposition'), null);
  assert.equal(
    (
      await post('/api/jobs', {
        sourceId: job.id,
        format: 'gif',
        duration: 1,
        crop: { x: 150, y: 0, width: 80, height: 60 },
      })
    ).status,
    400,
  );
  assert.equal(
    (await post('/api/jobs', { sourceId: job.id, format: 'gif', duration: 31 })).status,
    400,
  );
  assert.equal(
    (await post('/api/jobs', { sourceId: job.id, format: 'gif', start: 1.5, duration: 1 })).status,
    400,
  );
});

test('GIF speed changes timing, finite playback is encoded, and existing GIFs can be edited', async () => {
  const job = await source('gif');
  for (const speed of [0.25, 0.5, 2, 4]) {
    const response = await post('/api/jobs', {
      sourceId: job.id,
      format: 'gif',
      duration: 1,
      speed,
      fps: 20,
      loop: -1,
    });
    assert.equal(response.status, 202);
    const done = await terminal(job.id);
    assert.equal(done.state, 'done', done.error);
    const info = await output(done, 'gif');
    assert.equal(Number(info.streams[0].nb_read_frames), 20 / speed);
    assert.ok(Math.abs(Number(info.format.duration) - 1 / speed) < 0.06);
    const bytes = await fs.readFile(path.join(root, job.id + '.gif'));
    assert.equal(bytes.includes(Buffer.from('NETSCAPE2.0')), false);
  }
  const imported = await source('gif', job.id + '.gif');
  const response = await post('/api/jobs', {
    sourceId: imported.id,
    format: 'gif',
    duration: imported.media.duration,
    speed: 0.5,
    loop: 2,
    fps: 20,
  });
  assert.equal(response.status, 202);
  const done = await terminal(imported.id);
  assert.equal(done.state, 'done', done.error);
  const info = await output(done, 'gif');
  assert.ok(Math.abs(Number(info.format.duration) - imported.media.duration * 2) < 0.06);
  const bytes = await fs.readFile(path.join(root, imported.id + '.gif'));
  const loopAt = bytes.indexOf(Buffer.from('NETSCAPE2.0'));
  assert.ok(loopAt >= 0);
  assert.equal(bytes.readUInt16LE(loopAt + 13), 2);
  const short = await post('/api/jobs', {
    sourceId: job.id,
    format: 'gif',
    duration: 0.1,
    speed: 4,
    fps: 10,
  });
  assert.equal(short.status, 202);
  const shortDone = await terminal(job.id);
  assert.equal(shortDone.state, 'done', shortDone.error);
  assert.ok(Number((await output(shortDone, 'gif')).streams[0].nb_read_frames) >= 1);
});

test('GIF caption pixels, rotation and palette survive the export pipeline', async () => {
  const sharp = require('sharp');
  const job = await source('gif');
  const width = 120,
    height = 200;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (y < 20 || y >= 180) {
        pixels[i] = y < 20 ? 255 : 0;
        pixels[i + 1] = y >= 180 ? 255 : 0;
        pixels[i + 3] = 255;
      }
    }
  const png = (
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
  ).toString('base64');
  const response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'gif',
    duration: 1,
    width: 240,
    rotate: 90,
    flip: 'horizontal',
    colors: 64,
    dither: 'none',
    overlay: { png, top: 20, bottom: 20 },
  });
  assert.equal(response.status, 202);
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const info = await output(done, 'gif');
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [width, height]);
  const decoded = execFileSync(
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-i',
      path.join(root, job.id + '.gif'),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { windowsHide: true },
  );
  assert.ok(decoded[0] > 240 && decoded[1] < 15);
  const bottom = (height - 1) * width * 3;
  assert.ok(decoded[bottom] < 15 && decoded[bottom + 1] > 240);
  const colors = new Set();
  for (let i = 0; i < decoded.length; i += 3)
    colors.add(decoded.subarray(i, i + 3).toString('hex'));
  assert.ok(colors.size <= 64);
  for (const overlay of [
    { png, top: 21, bottom: 20 },
    { png: 'bad', top: 0, bottom: 0 },
  ])
    assert.equal(
      (await post('/api/jobs', { sourceId: job.id, format: 'gif', duration: 1, overlay })).status,
      400,
    );
  for (const options of [
    { speed: 0 },
    { speed: 5 },
    { loop: 0.5 },
    { colors: 5 },
    { dither: 'x;movie=file' },
  ])
    assert.equal(
      (await post('/api/jobs', { sourceId: job.id, format: 'gif', duration: 1, ...options }))
        .status,
      400,
    );
});

test('image effects reduce frame colours before composing unchanged caption bands', async () => {
  const sharp = require('sharp');
  const job = await source('gif');
  const pixels = Buffer.alloc(160 * 140 * 4);
  for (let i = 0; i < 160 * 20 * 4; i += 4) {
    pixels[i] = 170;
    pixels[i + 1] = 85;
    pixels[i + 2] = 51;
    pixels[i + 3] = 255;
  }
  const png = (
    await sharp(pixels, { raw: { width: 160, height: 140, channels: 4 } })
      .png()
      .toBuffer()
  ).toString('base64');
  const versions = [];
  for (const pattern of ['none', 'bayer', 'checker', 'lines']) {
    const response = await post('/api/jobs', {
      sourceId: job.id,
      format: 'gif',
      duration: 0.2,
      width: 160,
      fps: 10,
      dither: 'none',
      pixelSize: 8,
      colorBits: 1,
      pattern,
      overlay: { png, top: 20, bottom: 0 },
    });
    assert.equal(response.status, 202);
    const done = await terminal(job.id);
    assert.equal(done.state, 'done', done.error);
    await output(done, 'gif');
    const decoded = execFileSync(
      binaries().ffmpeg,
      [
        '-v',
        'error',
        '-i',
        path.join(root, job.id + '.gif'),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    assert.deepEqual([...decoded.subarray(0, 4)], [170, 85, 51, 255]);
    const image = decoded.subarray(160 * 20 * 4);
    const colors = new Set();
    for (let i = 0; i < image.length; i += 4) colors.add(image.subarray(i, i + 3).toString('hex'));
    assert.ok(colors.size <= 8);
    for (const value of image) assert.ok(value === 0 || value === 255);
    assert.deepEqual(image.subarray(0, 4), image.subarray(4, 8));
    versions.push(image);
  }
  assert.notDeepEqual(versions[0], versions[1]);
  for (const options of [{ pixelSize: 0 }, { colorBits: 9 }, { pattern: 'unknown' }])
    assert.equal(
      (await post('/api/jobs', { sourceId: job.id, format: 'gif', duration: 1, ...options }))
        .status,
      400,
    );
});

test('native crop previews decode real pixels at the requested time without changing the initial frame', async () => {
  const job = await source('gif');
  const initial = Buffer.from(await (await req(`/api/sources/${job.id}/frame`)).arrayBuffer());
  const response = await req(`/api/sources/${job.id}/frame?time=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  const selected = Buffer.from(await response.arrayBuffer());
  assert.notDeepEqual(selected, initial);
  const decoded = execFileSync(
    binaries().ffmpeg,
    ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { windowsHide: true, input: selected },
  );
  assert.equal(decoded.length, 160 * 120 * 3);
  assert.ok(
    decoded.some((value) => value > 100),
    'preview contains visible pixels',
  );
  const expected = execFileSync(
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-ss',
      '1',
      '-i',
      path.join(root, 'source.mp4'),
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    { windowsHide: true },
  );
  assert.deepEqual(selected, expected);
  assert.deepEqual(
    Buffer.from(await (await req(`/api/sources/${job.id}/frame`)).arrayBuffer()),
    initial,
  );
  for (const time of ['-1', 'NaN', 'Infinity', '2', '500'])
    assert.equal((await req(`/api/sources/${job.id}/frame?time=${time}`)).status, 400);
  const concurrent = await Promise.all([
    req(`/api/sources/${job.id}/frame?time=.3`),
    req(`/api/sources/${job.id}/frame?time=.4`),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  await Promise.all(concurrent.map((r) => r.arrayBuffer()));
});

test('50 FPS GIF preserves fifty frames and exact 20 ms delays without changing playback speed', async () => {
  const job = await source('gif', 'smooth.mp4');
  assert.equal(
    (
      await post('/api/jobs', {
        sourceId: job.id,
        format: 'gif',
        start: 0,
        duration: 1,
        width: 240,
        fps: 50,
      })
    ).status,
    202,
  );
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const info = await output(done, 'gif');
  assert.equal(Number(info.streams[0].nb_read_frames), 50);
  assert.ok(info.frames.every((frame) => Math.abs(Number(frame.duration_time) - 0.02) < 0.0001));
  for (const fps of [60, 120])
    assert.equal(
      (await post('/api/jobs', { sourceId: job.id, format: 'gif', duration: 1, fps })).status,
      400,
    );
});
test('tool pages share controls and invalid remote links are rejected before network work', async () => {
  for (const tool of ['mp3', 'mp4', 'gif']) {
    const html = await (await req('/' + tool)).text();
    assert.match(html, new RegExp(`data-tool="${tool}"`));
    assert.match(html, /id="source-url"/);
  }
  assert.equal(
    (await post('/api/sources', { url: 'https://127.0.0.1/private', tool: 'mp3' })).status,
    400,
  );
  assert.equal(
    (await post('/api/sources', { url: 'https://youtu.be/Fixture0001', tool: 'unknown' })).status,
    400,
  );
});

test('portrait rotation and silent video work in both MP4 and cropped GIF outputs', async () => {
  const job = await source('gif', 'rotated.mp4');
  assert.deepEqual([job.media.width, job.media.height, job.media.audio], [120, 160, false]);
  let response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'mp4',
    height: 0,
    quality: 23,
  });
  assert.equal(response.status, 202);
  let done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  let info = await output(done, 'mp4');
  assert.equal(info.streams.length, 1);
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [120, 160]);
  response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'gif',
    start: 0.5,
    duration: 1,
    width: 240,
    fps: 10,
    crop: { x: 30, y: 40, width: 60, height: 80 },
  });
  assert.equal(response.status, 202);
  done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  info = await output(done, 'gif');
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [60, 80]);
});

test('simultaneous tabs cannot reserve multiple source jobs', async () => {
  const bytes = await fs.readFile(path.join(root, 'source.mp4'));
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      req('/api/sources?tool=gif&name=source.mp4', { method: 'POST', body: bytes }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409, 409, 409]);
  const accepted = responses.find((r) => r.status === 202),
    job = await terminal((await accepted.json()).id);
  assert.equal(job.state, 'ready', job.error);
  assert.equal((await req(`/api/sources/${job.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/jobs/${job.id}`)).status, 404);
});
