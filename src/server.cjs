const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const outputTypes = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  gif: 'image/gif',
};
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  ...Object.fromEntries(Object.entries(outputTypes).map(([key, value]) => ['.' + key, value])),
};
const activeStates = new Set(['uploading', 'downloading', 'inspecting', 'converting']);
const mediaTools = new Set(['mp3', 'mp4', 'gif']);
const registry = require('../assets/tools.json');
async function bodyJSON(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16384) throw new Error('Request is too large.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid request.');
  }
}
async function serveFile(req, res, file, type, attachment) {
  const size = (await fsp.stat(file)).size;
  let start = 0,
    end = size - 1,
    code = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (
      start > end ||
      start >= size ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end)
    ) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    code = 206;
  }
  const headers = {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (attachment)
    headers['Content-Disposition'] =
      `attachment; filename="omnia.${path.extname(file).slice(1)}"; filename*=UTF-8''${encodeURIComponent(attachment).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(file, { start, end }), res);
}
async function startServer({
  port = 0,
  networkOptions,
  workbench,
  toolHost,
  remoteMedia,
  remoteNetwork,
} = {}) {
  const host = toolHost || require('./tool-health.cjs').createToolHost();
  const media =
    remoteMedia ||
    (await host.register(['mp3', 'mp4', 'gif'], async () => {
      const engine = require('./media.cjs'),
        links = require('./links.cjs');
      return { ...engine, identifyLink: links.identifyLink, downloadSource: links.download };
    }));
  const localNetwork =
    remoteNetwork ||
    (await host.register(['network', 'speed'], async () => {
      const module = require('./network.cjs');
      return { ...module.createNetworkService(networkOptions), subnet: module.subnet };
    }));
  const { createSessions, httpAccess } = require('./access.cjs');
  const sessions = createSessions();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'omnia-'));
  const jobs = new Map();
  let origin,
    closing = false,
    accepting = false;
  const busy = () =>
    !!remoteMedia?.isBusy() ||
    !!workbench?.isBusy() ||
    localNetwork.isBusy() ||
    accepting ||
    [...jobs.values()].some(
      (job) => activeStates.has(job.state) || (job.state === 'cancelled' && job.task),
    );
  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const view = (job) => ({
    id: job.id,
    name: job.name,
    format: job.format,
    state: job.state,
    progress: job.progress,
    duration: job.duration,
    error: job.error,
    media: job.media,
    platform: job.platform,
    frame: !!job.frame,
  });
  async function remove(job) {
    if (!job.directory.startsWith(root + path.sep)) throw new Error('Invalid temporary directory.');
    await job.previewTask?.catch(() => {});
    await fsp.rm(job.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  async function create(name, tool) {
    const inactive = [...jobs.values()]
      .filter((job) => !activeStates.has(job.state) && !job.task)
      .sort((a, b) => a.created - b.created);
    while (jobs.size >= 6 && inactive.length) {
      const old = inactive.shift();
      jobs.delete(old.id);
      await remove(old);
    }
    const id = crypto.randomUUID(),
      directory = path.join(root, id);
    await fsp.mkdir(directory);
    const job = { id, directory, name, tool, state: 'uploading', progress: 0, created: Date.now() };
    jobs.set(id, job);
    return job;
  }
  function launch(job, operation) {
    job.task = (async () => {
      try {
        await operation();
      } catch (error) {
        if (job.state !== 'cancelled') {
          job.state = 'error';
          job.error = error.message;
        }
      } finally {
        if (['error', 'cancelled'].includes(job.state)) await remove(job).catch(() => {});
        job.task = null;
      }
    })();
  }
  async function prepare(job, autoOptions) {
    if (job.state === 'cancelled' || closing) return;
    job.state = 'inspecting';
    job.progress = 0;
    await media.probe(job);
    if (job.state === 'cancelled' || closing) return;
    if (job.tool === 'mp3' && !job.media.audio)
      throw Error('No audio track found. Choose an audio file or a video with sound.');
    if (job.tool !== 'mp3' && !job.media.video)
      throw Error('No video track found. Choose a video file.');
    if (job.tool === 'gif' || job.tool === 'mp4') await media.frame(job);
    if (job.state === 'cancelled' || closing) return;
    if (autoOptions) {
      await media.convert(job, autoOptions);
      await fsp.rm(job.input, { force: true }).catch(() => {});
    } else {
      job.state = 'ready';
      job.progress = 100;
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== new URL(origin).host)
        return json(res, 403, { error: 'Invalid host.' });
      const url = new URL(req.url, origin);
      if (
        req.method === 'GET' &&
        ['/launch', '/desktop'].includes(url.pathname) &&
        sessions.redeem(url.searchParams.get('key'))
      ) {
        const scope = sessions.redeem(url.searchParams.get('key'));
        const tool = scope === 'media' ? 'mp3' : scope;
        if (
          (url.pathname === '/desktop') !== (scope === 'home') ||
          (url.searchParams.has('tool') && url.searchParams.get('tool') !== tool)
        )
          return json(res, 403, { error: 'Invalid launch scope.' });
        res.writeHead(302, {
          'Set-Cookie': `${sessions.cookie(scope)}; HttpOnly; SameSite=Strict; Path=/`,
          Location: url.pathname === '/desktop' ? '/launcher.html' : `/${tool}`,
        });
        return res.end();
      }
      const scope = sessions.identify(req.headers.cookie);
      if (!scope) return json(res, 401, { error: 'Open this tool from OMNIA to connect.' });
      if (req.headers.origin && req.headers.origin !== origin)
        return json(res, 403, { error: 'Invalid origin.' });
      if (['POST', 'DELETE'].includes(req.method) && req.headers['x-omnia'] !== '1')
        return json(res, 403, { error: 'Invalid request.' });
      httpAccess(scope, url.pathname, req.method);
      if (req.method === 'GET' && url.pathname === '/tools.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('window.omniaTools=' + JSON.stringify(registry) + ';');
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/preview/')) {
        if (workbench?.ownerOf(url.pathname.slice('/api/files/preview/'.length)) !== scope)
          return json(res, 403, { error: 'This preview belongs to another tool.' });
        const asset = await workbench?.asset(url.pathname.slice('/api/files/preview/'.length));
        if (!asset || asset.role !== 'preview')
          return json(res, 404, { error: 'Preview expired. Select the image again.' });
        await serveFile(req, res, asset.path, asset.type);
        return;
      }
      if (
        url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/api/network/') &&
        !url.pathname.startsWith('/api/files/') &&
        !remoteMedia &&
        host.blocked('mp3')
      )
        return json(res, 503, {
          error: 'The media tools are unavailable. Reset them from the directory.',
        });
      if (
        remoteMedia &&
        url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/api/network/') &&
        !url.pathname.startsWith('/api/files/')
      ) {
        const connection = await remoteMedia
          .forTool(scope === 'media' ? 'mp3' : scope)
          .connection();
        const cookie = connection.cookie;
        const headers = { ...req.headers, host: new URL(connection.origin).host, cookie };
        delete headers.origin;
        await new Promise((resolve, reject) => {
          const upstream = http.request(
            connection.origin + url.pathname + url.search,
            { method: req.method, headers },
            (response) => {
              res.writeHead(response.statusCode, response.headers);
              response.pipe(res);
              response.on('end', resolve);
              response.on('error', reject);
            },
          );
          upstream.setTimeout(120000, () =>
            upstream.destroy(Error('The media tool stopped responding.')),
          );
          upstream.on('error', reject);
          req.on('aborted', () => upstream.destroy());
          res.on('close', () => upstream.destroy());
          req.pipe(upstream);
        });
        return;
      }
      if (url.pathname.startsWith('/api/network/')) {
        const network = remoteNetwork ? remoteNetwork.forTool(scope) : localNetwork;
        if (closing) return json(res, 503, { error: 'OMNIA is closing.' });
        const route = url.pathname.slice('/api/network/'.length);
        if (req.method === 'GET' && route === 'quick') return json(res, 200, await network.quick());
        if (req.method === 'GET' && route === 'info')
          return json(res, 200, await network.info(url.searchParams.get('refresh') === '1'));
        if (req.method === 'GET' && route === 'job') return json(res, 200, await network.view());
        if (req.method === 'GET' && route === 'speed-servers')
          return json(
            res,
            200,
            remoteNetwork ? await network.serverList() : await require('./speed.cjs').serverList(),
          );
        if (req.method === 'POST') {
          const data = await bodyJSON(req);
          httpAccess(scope, url.pathname, req.method, data);
          if (route === 'cancel') {
            await network.cancel();
            return json(res, 200, await network.view());
          }
          if (route === 'subnet') return json(res, 200, await network.subnet(data.cidr));
          if (busy())
            return json(res, 409, {
              error: 'Another operation is running. Finish or cancel it first.',
            });
          if (route === 'run') return json(res, 202, await network.start(data.kind, data));
          if (route === 'action/prepare')
            return json(res, 200, await network.prepare(data.action, data.adapter));
          if (route === 'action/execute') return json(res, 202, await network.execute(data.id));
        }
        return json(res, 404, { error: 'Unknown network operation.' });
      }
      if (req.method === 'POST' && ['/api/sources', '/api/jobs'].includes(url.pathname)) {
        if (closing) return json(res, 503, { error: 'OMNIA is closing.' });
        if (busy())
          return json(res, 409, {
            error: 'Another tool is working. Finish or cancel that operation first.',
          });
        accepting = true;
        try {
          const isJSON = (req.headers['content-type'] || '').includes('application/json');
          const body = isJSON ? await bodyJSON(req) : null;
          httpAccess(scope, url.pathname, req.method, body || Object.fromEntries(url.searchParams));
          if (url.pathname === '/api/jobs' && body?.sourceId) {
            const job = jobs.get(body.sourceId);
            if (job && scope !== 'media' && job.tool !== scope)
              return json(res, 403, { error: 'This file belongs to another tool.' });
            if (!job || !['ready', 'done'].includes(job.state))
              return json(res, 400, { error: 'Load a file or link first.' });
            const opts = media.optionsFor(body.format, body, job.media);
            if (job.output) await fsp.rm(job.output, { force: true });
            job.state = 'converting';
            job.error = null;
            job.created = Date.now();
            launch(job, () => media.convert(job, opts));
            return json(res, 202, view(job));
          }
          const tool =
            body?.tool || url.searchParams.get('tool') || (scope === 'media' ? 'mp3' : scope);
          if (!mediaTools.has(tool)) return json(res, 400, { error: 'Unknown tool.' });
          if (body) {
            if (url.pathname !== '/api/sources')
              return json(res, 400, { error: 'Load a source first.' });
            const link = media.identifyLink(body.url);
            const job = await create('video', tool);
            job.state = 'downloading';
            job.platform = link.platform;
            launch(job, async () => {
              await media.downloadSource(job, link.url, tool);
              await prepare(job);
            });
            return json(res, 202, view(job));
          }
          const name = path
            .basename((url.searchParams.get('name') || '').replaceAll('\\', '/'))
            .slice(0, 240);
          const extension = path.extname(name).toLowerCase();
          if (
            !media.extensions.has(extension) &&
            !(tool === 'gif' && media.imageExtensions.has(extension))
          )
            return json(res, 400, {
              error:
                tool === 'gif'
                  ? 'Choose a video or a PNG, JPG, WebP, BMP or TIFF image.'
                  : 'Choose a supported audio or video file. Use the GIF tool for images.',
            });
          if (Number(req.headers['content-length']) > media.LIMIT)
            return json(res, 413, { error: 'Choose a file smaller than 2 GB.' });
          const autoOptions =
            url.pathname === '/api/jobs'
              ? media.optionsFor(
                  url.searchParams.get('format') || 'mp3',
                  Object.fromEntries(url.searchParams),
                )
              : null;
          const job = await create(name, tool);
          job.input = path.join(job.directory, 'source' + path.extname(name));
          let size = 0;
          try {
            await pipeline(
              req,
              new Transform({
                transform(chunk, _, cb) {
                  size += chunk.length;
                  cb(
                    size > media.LIMIT ? new Error('Choose a file smaller than 2 GB.') : null,
                    chunk,
                  );
                },
              }),
              fs.createWriteStream(job.input),
            );
            if (!size) throw new Error('This file is empty.');
            if (closing) throw new Error('OMNIA is closing.');
            launch(job, () => prepare(job, autoOptions));
            return json(res, 202, view(job));
          } catch (error) {
            job.state = 'error';
            await remove(job).catch(() => {});
            return json(res, 400, { error: error.message });
          }
        } finally {
          accepting = false;
        }
      }
      const match =
        /^\/api\/(?:jobs|sources)\/([a-f0-9-]+)(\/download|\/result|\/cancel|\/frame|\/media)?$/.exec(
          url.pathname,
        );
      if (match) {
        const job = jobs.get(match[1]);
        if (job && scope !== 'media' && job.tool !== scope)
          return json(res, 403, { error: 'This file belongs to another tool.' });
        if (!job) return json(res, 404, { error: 'This file has expired. Load it again.' });
        if (req.method === 'GET' && !match[2]) return json(res, 200, view(job));
        if (req.method === 'POST' && match[2] === '/cancel') {
          if (activeStates.has(job.state)) {
            job.state = 'cancelled';
            media.stop(job);
          }
          return json(res, 200, view(job));
        }
        if (req.method === 'DELETE' && !match[2]) {
          if (activeStates.has(job.state))
            return json(res, 409, { error: 'Cancel this operation first.' });
          if (job.task) await job.task;
          jobs.delete(job.id);
          await remove(job);
          return json(res, 200, { removed: true });
        }
        if (
          ['GET', 'HEAD'].includes(req.method) &&
          match[2] === '/download' &&
          job.state === 'done'
        ) {
          await serveFile(
            req,
            res,
            job.output,
            outputTypes[job.format],
            path.parse(job.name).name + '.' + job.format,
          );
          return;
        }
        if (
          ['GET', 'HEAD'].includes(req.method) &&
          match[2] === '/result' &&
          job.state === 'done'
        ) {
          await serveFile(req, res, job.output, outputTypes[job.format]);
          return;
        }
        if (['GET', 'HEAD'].includes(req.method) && ['ready', 'done'].includes(job.state)) {
          if (match[2] === '/frame' && job.frame) {
            const time = Number(url.searchParams.get('time') || 0);
            if (!Number.isFinite(time) || time < 0 || time >= (job.duration || 86400))
              return json(res, 400, { error: 'Choose a preview time inside the video.' });
            if (time === 0 || job.media.still) {
              await serveFile(req, res, job.frame, job.media.still ? 'image/png' : 'image/jpeg');
              return;
            }
            if (job.previewTask)
              return json(res, 409, {
                error: 'A preview is still loading. Try again in a moment.',
              });
            const worker = { ...job, child: null, linkAbort: null };
            job.previewWorker = worker;
            // Atomic frame extraction and delivery.
            job.previewTask = (async () => {
              await media.frame(worker, time, true);
              await serveFile(req, res, worker.frame, 'image/jpeg');
            })();
            try {
              await job.previewTask;
            } finally {
              job.previewTask = null;
              job.previewWorker = null;
            }
            return;
          }
          if (match[2] === '/media' && job.input) {
            await serveFile(req, res, job.input, mime[path.extname(job.input)]);
            return;
          }
        }
      }
      if (req.method === 'GET') {
        const files = {
          ...Object.fromEntries(registry.map((tool) => ['/' + tool.id, 'web/' + tool.page])),
          '/tool-health.js': 'web/tool-health.js',
          '/native-router.js': 'web/native-router.js',
          '/admin-indicators.js': 'web/admin-indicators.js',
          '/ssh.js': 'web/ssh.js',
          '/ssh.css': 'web/ssh.css',
          '/file-tools.js': 'web/file-tools.js',
          '/location-browser.js': 'web/location-browser.js',
          '/file-tools.css': 'web/file-tools.css',
          '/system-tools.css': 'web/system-tools.css',
          '/system-tools.js': 'web/system-tools.js',
          '/diskspace.js': 'web/diskspace.js',
          '/repair.js': 'web/repair.js',
          '/firewall.js': 'web/firewall.js',
          '/drivers.js': 'web/drivers.js',
          '/drivers.css': 'web/drivers.css',
          '/directory.js': 'web/directory.js',
          '/workbench.js': 'web/workbench.js',
          '/workbench.css': 'web/workbench.css',
          '/': 'web/launcher.html',
          '/mp3': 'web/index.html',
          '/mp4': 'web/mp4.html',
          '/gif': 'web/gif.html',
          '/network': 'web/network.html',
          '/speed': 'web/speed.html',
          '/drives': 'web/drives.html',
          '/drives.js': 'web/drives.js',
          '/network.js': 'web/network.js',
          '/network.css': 'web/network.css',
          '/router.js': 'web/router.js',
          '/app-shell.js': 'web/app-shell.js',
          '/launcher.html': 'web/launcher.html',
          '/style.css': 'web/style.css',
          '/converter.js': 'web/converter.js',
          '/crop.js': 'web/crop.js',
          '/launcher.js': 'web/launcher.js',
          '/insignia.js': 'web/insignia.js',
          '/settings.js': 'web/settings.js',
          '/settings.css': 'web/settings.css',
          '/logo.txt': 'assets/logo.txt',
          '/icon.png': 'assets/icon.png',
        };
        if (files[url.pathname]) {
          const file = path.join(__dirname, '..', files[url.pathname]);
          res.writeHead(200, { 'Content-Type': mime[path.extname(file)] });
          res.end(await fsp.readFile(file));
          return;
        }
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent)
        json(res, error.code === 'OMNIA_ACCESS_DENIED' ? 403 : 400, {
          error:
            error.code === 'ENOENT'
              ? 'This file is no longer available. Load it again.'
              : error.message || 'OMNIA could not complete the request.',
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const expiry = setInterval(() => {
    for (const [id, job] of jobs)
      if (Date.now() - job.created > 60 * 60 * 1000 && !activeStates.has(job.state) && !job.task) {
        jobs.delete(id);
        void remove(job).catch(() => {});
      }
  }, 60000);
  expiry.unref();
  return {
    origin,
    url: `${origin}/launch?key=${sessions.launch('media')}`,
    desktopUrl: `${origin}/desktop?key=${sessions.launch('home')}`,
    toolURL: (tool) => `${origin}/launch?key=${sessions.launch(tool)}&tool=${tool}`,
    sessionCookie: (scope) => sessions.cookie(scope),
    isBusy: busy,
    async close() {
      closing = true;
      clearInterval(expiry);
      for (const job of jobs.values())
        if (activeStates.has(job.state)) {
          job.state = 'cancelled';
          media.stop(job);
        }
      for (const job of jobs.values())
        if (job.previewWorker) {
          job.previewWorker.state = 'cancelled';
          media.stop(job.previewWorker);
        }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([
        localNetwork.close(),
        ...[...jobs.values()].flatMap((job) => [job.task, job.previewTask]),
      ]);
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
module.exports = {
  startServer,
  get binaries() {
    return require('./media.cjs').binaries;
  },
  get extensions() {
    return require('./media.cjs').extensions;
  },
};
