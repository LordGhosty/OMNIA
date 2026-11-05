const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { startServer, binaries } = require('../src/server.cjs');
let server, cookie, root;
const ffmpeg = (args) =>
  execFileSync(binaries().ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true });
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-image-test-'));
  server = await startServer();
  cookie = (await fetch(server.url, { redirect: 'manual' })).headers
    .get('set-cookie')
    .split(';')[0];
  for (const ext of ['png', 'jpg', 'webp', 'bmp', 'tiff'])
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=1',
      '-frames:v',
      '1',
      path.join(root, 'source.' + ext),
    ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=black@0:size=80x60,format=rgba,drawbox=x=20:y=10:w=40:h=40:color=red:t=fill:replace=1',
    '-frames:v',
    '1',
    path.join(root, 'transparent.png'),
  ]);
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
async function source(file, tool = 'gif', bytes) {
  const response = await req(`/api/sources?tool=${tool}&name=${file}`, {
    method: 'POST',
    body: bytes || (await fs.readFile(path.join(root, file))),
  });
  assert.equal(response.status, 202);
  return terminal((await response.json()).id);
}
async function convert(job, options = {}) {
  const response = await post('/api/jobs', {
    sourceId: job.id,
    format: 'gif',
    width: 240,
    ...options,
  });
  assert.equal(response.status, 202);
  const done = await terminal(job.id);
  assert.equal(done.state, 'done', done.error);
  const result = await req(`/api/jobs/${job.id}/result`);
  assert.equal(result.headers.get('content-type'), 'image/gif');
  const file = path.join(root, job.id + '.gif');
  const bytes = Buffer.from(await result.arrayBuffer());
  await fs.writeFile(file, bytes);
  assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')), 'loop extension exists');
  const info = JSON.parse(
    execFileSync(
      binaries().ffprobe,
      ['-v', 'error', '-count_frames', '-show_frames', '-show_streams', '-of', 'json', file],
      { windowsHide: true },
    ),
  );
  const stream = info.streams[0];
  assert.equal(Number(stream.nb_read_frames), 2);
  const decoded = ffmpeg([
    '-i',
    file,
    '-frames:v',
    '2',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1',
  ]);
  const frameSize = stream.width * stream.height * 4;
  assert.equal(decoded.length, frameSize * 2);
  assert.deepEqual(
    decoded.subarray(0, frameSize),
    decoded.subarray(frameSize),
    'both frames look exactly the same',
  );
  assert.ok(
    Math.abs(info.frames.reduce((sum, f) => sum + Number(f.pkt_duration_time), 0) - 1) < 0.02,
  );
  return { stream, decoded, bytes };
}
test('PNG, JPEG, WebP, BMP and TIFF produce motionless looping GIFs with exact crops', async () => {
  for (const ext of ['png', 'jpg', 'webp', 'bmp', 'tiff']) {
    const file = 'source.' + ext,
      original = await fs.readFile(path.join(root, file));
    const job = await source(file);
    assert.equal(job.state, 'ready', job.error);
    assert.equal(job.media.still, true);
    assert.deepEqual([job.media.width, job.media.height], [160, 120]);
    const preview = await req(`/api/sources/${job.id}/frame`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const { stream } = await convert(job, { crop: { x: 11, y: 7, width: 81, height: 61 } });
    assert.deepEqual([stream.width, stream.height], [81, 61]);
    assert.deepEqual(await fs.readFile(path.join(root, file)), original);
  }
});
test('transparent images keep transparent backgrounds in preview and both GIF frames', async () => {
  const job = await source('transparent.png');
  assert.equal(job.state, 'ready', job.error);
  const { decoded, stream } = await convert(job);
  assert.deepEqual([stream.width, stream.height], [80, 60]);
  assert.equal(decoded[3], 0);
  assert.equal(decoded[(30 * 80 + 30) * 4 + 3], 255);
  assert.ok(decoded[(30 * 80 + 30) * 4] > 240);
  const preview = Buffer.from(await (await req(`/api/sources/${job.id}/frame`)).arrayBuffer());
  const rgba = execFileSync(
    binaries().ffmpeg,
    ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { windowsHide: true, input: preview },
  );
  assert.equal(rgba[3], 0);
});
test('images remain invalid for MP3/MP4, including renamed files and cross-tool conversion', async () => {
  const bytes = await fs.readFile(path.join(root, 'source.png'));
  for (const tool of ['mp3', 'mp4']) {
    assert.equal(
      (await req(`/api/sources?tool=${tool}&name=source.png`, { method: 'POST', body: bytes }))
        .status,
      400,
    );
    const renamed = await source('renamed.mp4', tool, bytes);
    assert.equal(renamed.state, 'error');
  }
  const job = await source('source.png');
  for (const format of ['mp3', 'mp4'])
    assert.equal((await post('/api/jobs', { sourceId: job.id, format })).status, 400);
  const broken = await source('broken.png', 'gif', Buffer.from('not an image'));
  assert.equal(broken.state, 'error');
});
