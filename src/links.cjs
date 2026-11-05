const fs = require('node:fs/promises');
const path = require('node:path');
const { binaries, run, LIMIT } = require('./media.cjs');
function identifyLink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Paste a complete video link.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new Error('Use an HTTPS video link.');
  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^m\./, '');
  let platform;
  if (host === 'youtu.be' || ['youtube.com', 'music.youtube.com'].includes(host)) {
    platform = 'YouTube';
    const id =
      host === 'youtu.be'
        ? url.pathname.slice(1).split('/')[0]
        : url.searchParams.get('v') ||
          url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (!/^[\w-]{11}$/.test(id || ''))
      throw new Error('Paste a link to one YouTube video, not a channel or playlist.');
    url = new URL(`https://www.youtube.com/watch?v=${id}`);
  } else if (host === 'instagram.com') {
    platform = 'Instagram';
    if (!/^\/(?:reel|reels|p|tv)\/[\w-]+\/?$/.test(url.pathname))
      throw new Error('Paste a link to an Instagram reel or video post.');
    url.search = '';
    url.hash = '';
  } else if (
    host === 'pin.it' ||
    /^(?:[a-z]{2}\.)?pinterest\.(?:com|co\.uk|de|fr|es|it|ca|com\.au|co\.kr|jp|pt|ch|at|se)$/.test(
      host,
    )
  ) {
    platform = 'Pinterest';
    if (host !== 'pin.it') {
      const pin = url.pathname.match(/^\/pin\/(?:[^/]+--)?(\d+)(?:\/sent)?\/?$/);
      if (!pin) throw new Error('Paste a link to a Pinterest video pin.');
      url = new URL(`https://www.pinterest.com/pin/${pin[1]}/`);
    }
    if (host === 'pin.it' && !/^\/[A-Za-z0-9]+\/?$/.test(url.pathname))
      throw new Error('This Pinterest short link is invalid.');
    url.search = '';
    url.hash = '';
  } else throw new Error('Use a YouTube, Instagram or Pinterest video link.');
  return { platform, url: url.href };
}
async function resolveShortLink(link, signal, fetcher = fetch) {
  let current = link;
  for (let i = 0; i < 6; i++) {
    if (!['pin.it', 'api.pinterest.com'].includes(new URL(current.url).hostname)) return current;
    const response = await fetcher(current.url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location)
      throw new Error('Could not resolve this Pinterest short link. Paste the full pin URL.');
    const next = new URL(location, current.url);
    // Restricted Pinterest redirect endpoint.
    if (
      next.protocol === 'https:' &&
      !next.username &&
      !next.password &&
      (!next.port || next.port === '443') &&
      next.hostname === 'api.pinterest.com' &&
      /^\/url_shortener\/[A-Za-z0-9]+\/redirect\/$/.test(next.pathname)
    ) {
      next.search = '';
      next.hash = '';
      current = { platform: 'Pinterest', url: next.href };
      continue;
    }
    current = identifyLink(next.href);
    if (current.platform !== 'Pinterest')
      throw new Error('That short link does not lead to a Pinterest video.');
  }
  if (['pin.it', 'api.pinterest.com'].includes(new URL(current.url).hostname))
    throw new Error('Too many redirects. Paste the full Pinterest pin URL.');
  return current;
}
function commonArgs() {
  const bin = binaries();
  return [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-cache-dir',
    '--no-playlist',
    '--playlist-items',
    '1',
    '--no-warnings',
    '--no-colors',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '--no-js-runtimes',
    '--js-runtimes',
    `deno:${bin.deno}`,
    '--ffmpeg-location',
    bin.ffmpeg,
    '--use-extractors',
    'youtube.*,instagram,pinterest',
    '--match-filters',
    '!is_live & !is_upcoming',
  ];
}
function readableError(error, platform) {
  const message = error.message || '';
  if (
    /sign in|login|log in|cookies|private|age.restrict|confirm you.re not a bot|challenge|403|429/i.test(
      message,
    )
  )
    return `${platform} restricted access to this video. It may require sign-in or be rate-limited. Try another public link, or use a local file.`;
  if (
    /not available|unavailable|removed|not found|no video|no video formats|unsupported url/i.test(
      message,
    )
  )
    return `${platform} could not provide a playable video for this link. It may be removed, restricted, or an image-only post.`;
  if (/timed out|timeout|resolve|connection|network/i.test(message))
    return `Could not reach ${platform}. Check your connection and try again.`;
  if (/size limit|smaller|too long|required media component/i.test(message)) return message;
  return `${platform} could not import this video. Try another public link or a local file. The site may need a newer OMNIA link component.`;
}
async function download(job, value, tool) {
  job.linkAbort = new AbortController();
  let link;
  try {
    link = await resolveShortLink(identifyLink(value), job.linkAbort.signal);
  } finally {
    job.linkAbort = null;
  }
  if (job.state === 'cancelled') throw new Error('Cancelled.');
  job.platform = link.platform;
  job.state = 'downloading';
  job.progress = 0;
  const format = tool === 'mp3' ? 'bestaudio/best' : 'bv*[height<=2160]+ba/b[height<=2160]/best';
  let downloaded;
  const args = [
    ...commonArgs(),
    '--max-filesize',
    String(LIMIT),
    '--no-part',
    '--newline',
    '--progress',
    '--progress-delta',
    '0.3',
    '--progress-template',
    'download:OMNIA_PROGRESS:%(progress._percent_str)s',
    '--print',
    'before_dl:OMNIA_TITLE:%(title)j',
    '--print',
    'after_move:OMNIA_FILE:%(filepath)j',
    '--no-simulate',
    '--merge-output-format',
    'mkv',
    '-f',
    format,
    '-o',
    path.join(job.directory, 'source.%(ext)s'),
    '--',
    link.url,
  ];
  try {
    await run(job, binaries().ytdlp, args, {
      timeout: 30 * 60 * 1000,
      diskLimit: true,
      onLine: (line) => {
        if (line.startsWith('OMNIA_PROGRESS:')) {
          const n = parseFloat(line.slice(15));
          if (Number.isFinite(n)) job.progress = Math.min(99, Math.round(n));
        }
        if (line.startsWith('OMNIA_TITLE:')) {
          try {
            job.name =
              String(JSON.parse(line.slice(12)))
                .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
                .slice(0, 180) || 'video';
          } catch {}
        }
        if (line.startsWith('OMNIA_FILE:')) {
          try {
            downloaded = JSON.parse(line.slice(11));
          } catch {}
        }
      },
    });
  } catch (error) {
    if (job.state === 'cancelled') throw error;
    throw new Error(readableError(error, link.platform));
  }
  if (!downloaded || path.dirname(path.resolve(downloaded)) !== path.resolve(job.directory))
    throw new Error('No downloadable video was found at this link.');
  const size = (await fs.stat(downloaded)).size;
  if (!size || size > LIMIT) throw new Error('The downloaded file is empty or exceeds 2 GB.');
  job.input = downloaded;
  if (!path.extname(job.name)) job.name += path.extname(downloaded);
}
module.exports = { identifyLink, resolveShortLink, commonArgs, readableError, download };
