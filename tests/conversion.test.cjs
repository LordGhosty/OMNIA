const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { startServer, binaries } = require('../src/server.cjs');
let server, cookie, root;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-test-'));
  server = await startServer();
  const auth = await fetch(server.url, { redirect: 'manual' });
  cookie = auth.headers.get('set-cookie').split(';')[0];
  const ff = binaries().ffmpeg;
  execFileSync(
    ff,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      path.join(root, 'tone.wav'),
    ],
    { windowsHide: true },
  );
  execFileSync(
    ff,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      '-shortest',
      path.join(root, 'video.mp4'),
    ],
    { windowsHide: true },
  );
  execFileSync(
    ff,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:d=1',
      '-c:v',
      'mpeg4',
      path.join(root, 'silent.mp4'),
    ],
    { windowsHide: true },
  );
});
after(async () => {
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function request(route, options = {}) {
  return fetch(server.origin + route, {
    ...options,
    headers: { Cookie: cookie, 'X-Omnia': '1', ...options.headers },
  });
}
async function submit(name, data, bitrate = 192, format = 'mp3') {
  const response = await request(
    `/api/jobs?name=${encodeURIComponent(name)}&bitrate=${bitrate}&format=${format}`,
    { method: 'POST', body: data },
  );
  return { status: response.status, data: await response.json() };
}
async function terminal(id) {
  for (let i = 0; i < 300; i++) {
    const job = await (await request(`/api/jobs/${id}`)).json();
    if (['done', 'error', 'cancelled'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Conversion timed out');
}
test('local server requires session and rejects external origins', async () => {
  assert.equal((await fetch(server.origin + '/')).status, 401);
  assert.equal((await request('/', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal(
    (
      await request('/api/jobs?name=a.wav&bitrate=192', {
        method: 'POST',
        headers: { 'X-Omnia': '' },
        body: 'x',
      })
    ).status,
    403,
  );
  assert.match(await (await request('/')).text(), /tool-categories/);
  assert.match(await (await request('/tools.js')).text(), /MP3 converter/);
  const logo = await fs.readFile(path.join(__dirname, '../assets/logo.txt'), 'utf8');
  assert.equal(await (await request('/logo.txt')).text(), logo);
  assert.equal(logo.trimEnd().split('\n').length, 8);
});
test('WAV becomes a valid MP3 at every selectable quality', async () => {
  const input = await fs.readFile(path.join(root, 'tone.wav'));
  for (const bitrate of [96, 128, 160, 192, 256, 320]) {
    const result = await submit('test tone.wav', input, bitrate);
    assert.equal(result.status, 202);
    const job = await terminal(result.data.id);
    assert.equal(job.state, 'done', job.error);
    const response = await request(`/api/jobs/${job.id}/download`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /test%20tone.mp3/);
    const output = path.join(root, `output-${bitrate}.mp3`);
    await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
    const info = JSON.parse(
      execFileSync(binaries().ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], {
        windowsHide: true,
      }),
    );
    assert.equal(info.streams[0].codec_name, 'mp3');
    assert.equal(Number(info.streams[0].bit_rate), bitrate * 1000);
    assert.ok(Number(info.streams[0].duration) >= 2);
  }
  assert.deepEqual(await fs.readFile(path.join(root, 'tone.wav')), input);
});
test('FLAC and WAV preserve integer samples, channels and sample rate; WAV preserves floating-point precision', async () => {
  const ff = binaries().ffmpeg;
  for (const codec of ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le']) {
    const source = path.join(root, `${codec}.wav`);
    execFileSync(
      ff,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=731:duration=0.25:sample_rate=48000',
        '-ac',
        '2',
        '-c:a',
        codec,
        source,
      ],
      { windowsHide: true },
    );
    const input = await fs.readFile(source);
    const decoded = (file) =>
      execFileSync(ff, ['-v', 'error', '-i', file, '-f', 'f64le', '-c:a', 'pcm_f64le', '-'], {
        windowsHide: true,
      });
    for (const format of ['flac', 'wav']) {
      const submitted = await submit(`${codec}.wav`, input, 192, format);
      assert.equal(submitted.status, 202);
      const job = await terminal(submitted.data.id);
      if (format === 'flac' && codec === 'pcm_s32le') {
        assert.equal(job.state, 'error');
        assert.match(job.error, /Choose WAV/);
        continue;
      }
      assert.equal(job.state, 'done', job.error);
      const response = await request(`/api/jobs/${job.id}/download`);
      assert.equal(response.headers.get('content-type'), `audio/${format}`);
      assert.match(response.headers.get('content-disposition'), new RegExp(`\\.${format}`));
      const output = path.join(root, `${codec}-output.${format}`);
      await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
      const stream = JSON.parse(
        execFileSync(binaries().ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], {
          windowsHide: true,
        }),
      ).streams[0];
      assert.equal(stream.sample_rate, '48000');
      assert.equal(stream.channels, 2);
      if (format === 'wav' || ['pcm_s16le', 'pcm_s24le'].includes(codec))
        assert.deepEqual(decoded(output), decoded(source));
      if (format === 'flac' && codec.includes('pcm_f'))
        assert.equal(stream.bits_per_raw_sample, '24');
    }
    assert.deepEqual(await fs.readFile(source), input);
  }
  assert.equal(
    (await submit('tone.wav', await fs.readFile(path.join(root, 'tone.wav')), 192, 'png')).status,
    400,
  );
});
test('MP4 with audio converts; silent MP4 is rejected', async () => {
  const valid = await submit('video.mp4', await fs.readFile(path.join(root, 'video.mp4')));
  assert.equal((await terminal(valid.data.id)).state, 'done');
  const silent = await submit('silent.mp4', await fs.readFile(path.join(root, 'silent.mp4')));
  const result = await terminal(silent.data.id);
  assert.equal(result.state, 'error');
  assert.match(result.error, /No audio track/);
});
test('images, renamed images, corrupt files, empty files and bad bitrates are rejected', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aoc8AAAAASUVORK5CYII=',
    'base64',
  );
  assert.equal((await submit('image.png', png)).status, 400);
  for (const bytes of [png, Buffer.from('not media')]) {
    const fake = await submit('renamed.mp4', bytes);
    assert.equal((await terminal(fake.data.id)).state, 'error');
  }
  assert.equal((await submit('empty.wav', Buffer.alloc(0))).status, 400);
  assert.equal((await submit('bad.wav', Buffer.from('x'), 12)).status, 400);
});
test('job can be cancelled and nonexistent output is not downloadable', async () => {
  const result = await submit('cancel.wav', await fs.readFile(path.join(root, 'tone.wav')));
  const response = await request(`/api/jobs/${result.data.id}/cancel`, { method: 'POST' });
  assert.equal((await response.json()).state, 'cancelled');
  assert.equal((await terminal(result.data.id)).state, 'cancelled');
  assert.equal((await request(`/api/jobs/${result.data.id}/download`)).status, 404);
});
