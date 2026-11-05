const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const LIMIT = 2 * 1024 ** 3;
const extensions = new Set(
  '.mp4 .m4a .m4v .mov .mkv .webm .avi .wav .mp3 .flac .ogg .opus .aac .wma .wmv .mpeg .mpg .ts .aif .aiff .amr .gif .mts .m2ts .3gp .3g2 .vob .flv .mka .ac3 .eac3 .ape .wv .caf .au .tta'.split(
    ' ',
  ),
);
const imageExtensions = new Set('.png .jpg .jpeg .webp .bmp .tif .tiff'.split(' '));
const formats =
  'mov,matroska,webm,avi,wav,mp3,flac,ogg,aac,asf,mpeg,mpegts,aiff,amr,gif,flv,ac3,eac3,ape,wv,caf,au,tta';
function binaries() {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'bin');
  const local = path.join(__dirname, '..', 'vendor', process.platform);
  const bundled = packaged && fs.existsSync(path.join(packaged, `ffmpeg${suffix}`));
  return {
    ffmpeg: bundled ? path.join(packaged, `ffmpeg${suffix}`) : require('ffmpeg-static'),
    ffprobe: bundled ? path.join(packaged, `ffprobe${suffix}`) : require('ffprobe-static').path,
    ytdlp: path.join(bundled ? packaged : local, `yt-dlp${suffix}`),
    deno: path.join(bundled ? packaged : local, `deno${suffix}`),
  };
}
function stop(job) {
  job.linkAbort?.abort();
  const child = job.child;
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    killer.on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill();
    }
  }
}
function run(
  job,
  executable,
  args,
  { timeout = 120000, onLine, maxOutput = 1024 * 1024, diskLimit = false } = {},
) {
  return new Promise((resolve, reject) => {
    if (job.state === 'cancelled') return reject(new Error('Cancelled.'));
    const child = spawn(executable, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      cwd: job.directory,
    });
    job.child = child;
    let stdout = '',
      stderr = '',
      pending = '',
      failure,
      checking = false;
    const timer = setTimeout(() => {
      failure = 'This operation took too long. Try a shorter video or another link.';
      stop(job);
    }, timeout);
    const watcher =
      diskLimit &&
      setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const entries = await fsp.readdir(job.directory);
          const sizes = await Promise.all(
            entries.map((name) =>
              fsp
                .stat(path.join(job.directory, name))
                .then((s) => s.size)
                .catch(() => 0),
            ),
          );
          if (sizes.reduce((a, b) => a + b, 0) > LIMIT * 2.5) {
            failure = 'Temporary files exceeded the size limit. Choose a smaller video.';
            stop(job);
          }
        } catch (error) {
          if (error.code !== 'ENOENT' && job.state !== 'cancelled') {
            failure = 'Could not check temporary media files.';
            stop(job);
          }
        } finally {
          checking = false;
        }
      }, 1000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput);
      pending += chunk;
      const lines = pending.split(/[\r\n]+/);
      pending = lines.pop();
      lines.forEach((line) => onLine?.(line));
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once('error', (error) => {
      failure =
        error.code === 'ENOENT'
          ? 'A required media component is missing. Reinstall OMNIA.'
          : error.message;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      if (job.child === child) job.child = null;
      if (pending) onLine?.(pending);
      if (failure || code !== 0)
        reject(new Error(failure || stderr.trim() || 'Media processing failed.'));
      else resolve(stdout);
    });
  });
}
const inputArgs = (job) => [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  job.imageFormat || formats,
  ...(job.imageFormat ? ['-f', job.imageFormat] : []),
  '-i',
  job.input,
];
async function imageFormat(file) {
  const handle = await fsp.open(file, 'r');
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png_pipe';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'jpeg_pipe';
  if (header.toString('ascii', 0, 2) === 'BM') return 'bmp_pipe';
  if (['49492a00', '4d4d002a'].includes(header.subarray(0, 4).toString('hex'))) return 'tiff_pipe';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
    return 'webp_pipe';
  return null;
}
async function probe(job) {
  let info;
  job.imageFormat = await imageFormat(job.input);
  if (job.imageFormat && job.tool !== 'gif')
    throw new Error(
      'Images are supported in the GIF tool. Choose an audio or video file for this tool.',
    );
  try {
    info = JSON.parse(
      await run(
        job,
        binaries().ffprobe,
        ['-v', 'error', ...inputArgs(job), '-show_streams', '-show_format', '-of', 'json'],
        { timeout: 30000 },
      ),
    );
  } catch {
    throw new Error(
      job.tool === 'gif'
        ? 'This file is damaged or is not a supported image/video file.'
        : 'This file is damaged or is not a supported audio/video file.',
    );
  }
  const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
  const video = info.streams?.find(
    (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  if (!audio && !video) throw new Error('No audio or video track found.');
  const rotation = Number(
    video?.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ||
      video?.tags?.rotate ||
      0,
  );
  const rotated = Math.abs(rotation) % 180 === 90;
  const ratio = (video?.sample_aspect_ratio || '1:1').split(':').map(Number);
  const sar = ratio[0] && ratio[1] ? ratio[0] / ratio[1] : 1;
  const width = Math.round((video?.width || 0) * sar),
    height = video?.height || 0;
  job.audio = audio;
  job.video = video;
  job.media = {
    audio: !!audio,
    video: !!video,
    still: !!job.imageFormat,
    width: rotated ? height : width,
    height: rotated ? width : height,
    duration: job.imageFormat
      ? 0
      : Number(info.format?.duration || video?.duration || audio?.duration) || 0,
  };
  if (job.media.still && (!width || !height || width * height > 40000000))
    throw new Error('Choose an image with at most 40 million pixels.');
  job.duration = job.media.duration;
  return job.media;
}
function number(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${label}.`);
  return n;
}
function optionsFor(format, input = {}, media) {
  if (!['mp3', 'flac', 'wav', 'mp4', 'gif'].includes(format))
    throw new Error('Choose MP3, FLAC, WAV, MP4 or GIF.');
  const options = { format };
  if (media?.still && format !== 'gif') throw new Error('Images can only be converted to GIF.');
  if (format !== 'gif') {
    options.start = number(input.start, 0, 0, media?.duration || 86400, 'start time');
    options.duration = number(input.duration, 0, 0, media?.duration || 86400, 'selection length');
    if (
      media?.duration &&
      (options.start >= media.duration ||
        (options.duration && options.start + options.duration > media.duration + 0.05))
    )
      throw Error('The selection must fit inside the source.');
    options.speed = number(input.speed, 1, 0.5, 2, 'playback speed');
    options.volume = number(input.volume, 0, -30, 12, 'volume');
    options.fadeIn = number(input.fadeIn, 0, 0, 30, 'fade in');
    options.fadeOut = number(input.fadeOut, 0, 0, 30, 'fade out');
    const length = (options.duration || (media?.duration || 0) - options.start) / options.speed;
    if (length > 0 && options.fadeIn + options.fadeOut > length)
      throw Error('Fades must fit inside the edited duration.');
    if (format === 'mp4') {
      options.rotate = Number(input.rotate || 0);
      if (![0, 90, 180, 270].includes(options.rotate)) throw Error('Invalid rotation.');
      if (input.flip !== undefined && !['none', 'horizontal', 'vertical'].includes(input.flip))
        throw Error('Invalid flip.');
      options.flip = input.flip || 'none';
      options.mute = input.mute === true;
    }
  }
  if (format === 'mp3') {
    options.bitrate = Number(input.bitrate ?? 192);
    if (![96, 128, 160, 192, 256, 320].includes(options.bitrate))
      throw new Error('Invalid MP3 quality.');
  }
  if (format === 'mp4') {
    options.height = Number(input.height ?? 1080);
    options.quality = Number(input.quality ?? 23);
    if (
      ![0, 480, 720, 1080, 2160].includes(options.height) ||
      ![18, 23, 28].includes(options.quality)
    )
      throw new Error('Invalid MP4 quality.');
  }
  if (format === 'gif') {
    options.start = media?.still
      ? 0
      : number(input.start, 0, 0, media?.duration || 86400, 'start time');
    options.duration = media?.still
      ? 1
      : number(input.duration, 5, 0.1, 30, 'GIF duration (maximum 30 seconds)');
    if (media?.duration && options.start + options.duration > media.duration + 0.05)
      throw new Error('The GIF selection extends beyond the video.');
    options.width = number(input.width, 480, 64, 1280, 'GIF width');
    options.fps = media?.still ? 2 : number(input.fps, 15, 5, 50, 'GIF frame rate');
    if (!Number.isInteger(options.width) || !Number.isInteger(options.fps))
      throw new Error('GIF size and frame rate must be whole numbers.');
  }
  if (['gif', 'mp4'].includes(format)) {
    if (input.crop) {
      const c = input.crop;
      const w = media?.width || 32768,
        h = media?.height || 32768;
      options.crop = {
        x: number(c.x, 0, 0, w - 1, 'crop X'),
        y: number(c.y, 0, 0, h - 1, 'crop Y'),
        width: number(c.width, w, 1, w, 'crop width'),
        height: number(c.height, h, 1, h, 'crop height'),
      };
      if (
        Object.values(options.crop).some((n) => !Number.isInteger(n)) ||
        options.crop.x + options.crop.width > w ||
        options.crop.y + options.crop.height > h
      )
        throw new Error('The crop must fit inside the source.');
      if (format === 'mp4' && (options.crop.width < 2 || options.crop.height < 2))
        throw Error('MP4 crops must be at least 2 × 2 pixels.');
    }
  }
  return options;
}
function audioEncoding(format, audio, bitrate) {
  if (format === 'mp3')
    return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-ar', '44100', '-ac', '2'];
  const sample = (audio.sample_fmt || '').replace(/p$/, '');
  const bits =
    Number(audio.bits_per_raw_sample || audio.bits_per_sample) ||
    { u8: 8, s16: 16, s32: 32, s64: 64, flt: 32, dbl: 64 }[sample] ||
    16;
  if (format === 'flac') {
    if (bits > 24 && !['flt', 'dbl'].includes(sample))
      throw new Error(
        'This source exceeds FLAC’s 24-bit setting. Choose WAV to preserve its full precision.',
      );
    return [
      '-c:a',
      'flac',
      '-compression_level',
      '8',
      '-sample_fmt',
      bits <= 16 ? 's16' : 's32',
      '-bits_per_raw_sample',
      bits <= 16 ? '16' : '24',
    ];
  }
  return [
    '-c:a',
    sample === 'flt'
      ? 'pcm_f32le'
      : sample === 'dbl'
        ? 'pcm_f64le'
        : bits <= 8
          ? 'pcm_u8'
          : bits <= 16
            ? 'pcm_s16le'
            : bits <= 24
              ? 'pcm_s24le'
              : bits <= 32
                ? 'pcm_s32le'
                : 'pcm_s64le',
  ];
}
async function convert(job, supplied) {
  const o = optionsFor(supplied.format, supplied, job.media);
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  let outputArgs,
    duration = job.duration;
  if (o.format !== 'gif') {
    if (o.start) base.push('-ss', String(o.start));
    if (o.duration) base.push('-t', String(o.duration));
    duration = (o.duration || Math.max(0, job.duration - o.start)) / o.speed;
  }
  if (['mp3', 'wav', 'flac'].includes(o.format)) {
    if (!job.audio)
      throw new Error('No audio track found. Choose an audio file or a video that contains sound.');
    outputArgs = ['-map', '0:a:0', '-vn', ...audioEncoding(o.format, job.audio, o.bitrate)];
  } else {
    if (!job.video) throw new Error('No video track found. Choose a video file.');
    if (o.format === 'mp4') {
      const height = o.height || job.media.height;
      const filters = ['scale=iw*sar:ih', 'setsar=1'];
      if (o.crop)
        filters.push(`crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}:exact=1`);
      if (o.rotate === 90) filters.push('transpose=1');
      if (o.rotate === 180) filters.push('hflip', 'vflip');
      if (o.rotate === 270) filters.push('transpose=2');
      if (o.flip !== 'none') filters.push(o.flip === 'horizontal' ? 'hflip' : 'vflip');
      filters.push(
        `scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2`,
        `scale=-2:min(${height}\\,ih):force_divisible_by=2`,
      );
      if (o.speed !== 1) filters.push(`setpts=(PTS-STARTPTS)/${o.speed}`);
      if (o.fadeIn) filters.push(`fade=t=in:st=0:d=${o.fadeIn}`);
      if (o.fadeOut)
        filters.push(`fade=t=out:st=${Math.max(0, duration - o.fadeOut)}:d=${o.fadeOut}`);
      outputArgs = [
        '-map',
        `0:${job.video.index}`,
        ...(o.mute ? ['-an'] : ['-map', '0:a:0?']),
        '-sn',
        '-dn',
        '-vf',
        filters.join(','),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(o.quality),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
      ];
    } else {
      duration = o.duration;
      const crop = o.crop
        ? `crop=${o.crop.width}:${o.crop.height}:${o.crop.x}:${o.crop.y}:exact=1,`
        : '';
      const timing = job.media.still
        ? 'trim=end_frame=1,loop=loop=1:size=1:start=0,setpts=N/(2*TB),'
        : `fps=${o.fps},`;
      const filter = `[0:${job.video.index}]format=rgba,scale=iw*sar:ih,setsar=1,${crop}${timing}scale=min(${o.width}\\,iw):-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=${job.media.still ? 'single' : 'diff'}[p];[b][p]paletteuse=dither=sierra2_4a${job.media.still ? ':new=1' : ''}`;
      outputArgs = ['-an', '-filter_complex', filter, '-loop', '0'];
      if (job.media.still)
        outputArgs.push('-frames:v', '2', '-r', '2', '-gifflags', '-offsetting-transdiff');
      else base.push('-ss', String(o.start), '-t', String(duration));
    }
  }
  if (o.format !== 'gif' && job.audio && !o.mute) {
    const filters = [];
    if (o.speed !== 1) filters.push(`atempo=${o.speed}`);
    if (o.volume) filters.push(`volume=${o.volume}dB`);
    if (o.fadeIn) filters.push(`afade=t=in:st=0:d=${o.fadeIn}`);
    if (o.fadeOut)
      filters.push(`afade=t=out:st=${Math.max(0, duration - o.fadeOut)}:d=${o.fadeOut}`);
    if (filters.length) outputArgs.push('-af', filters.join(','));
  }
  job.format = o.format;
  job.output = path.join(job.directory, `output.${o.format}`);
  job.state = 'converting';
  job.progress = 0;
  const args = [
    ...base,
    ...inputArgs(job),
    ...(o.format === 'gif' ? ['-t', String(duration)] : []),
    '-map_metadata',
    '-1',
    ...outputArgs,
    '-threads',
    '2',
    '-filter_complex_threads',
    '1',
    '-progress',
    'pipe:1',
    '-nostats',
    job.output,
  ];
  await run(job, binaries().ffmpeg, args, {
    timeout: 2 * 60 * 60 * 1000,
    diskLimit: true,
    onLine: (line) => {
      if (line.startsWith('out_time_us=') && duration)
        job.progress = Math.min(
          99,
          Math.round((Number(line.split('=')[1]) / 1000000 / duration) * 100),
        );
    },
  });
  if (job.state !== 'cancelled') {
    job.state = 'done';
    job.progress = 100;
  }
}
async function frame(job, time = 0, selected = false) {
  if (!job.video) return;
  job.frame = path.join(
    job.directory,
    selected ? 'selected-frame.jpg' : job.media.still ? 'frame.png' : 'frame.jpg',
  );
  if (selected) await fsp.rm(job.frame, { force: true });
  await run(
    job,
    binaries().ffmpeg,
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      ...(time > 0 ? ['-ss', String(time)] : []),
      ...inputArgs(job),
      '-map',
      `0:${job.video.index}`,
      '-an',
      '-vf',
      'scale=min(960\\,iw*sar):-1,setsar=1',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      job.frame,
    ],
    { timeout: 60000 },
  );
  if (!(await fsp.stat(job.frame)).size)
    throw new Error('Could not read a preview frame. Choose another start time.');
}
module.exports = {
  LIMIT,
  extensions,
  imageExtensions,
  binaries,
  run,
  stop,
  probe,
  optionsFor,
  convert,
  frame,
};
