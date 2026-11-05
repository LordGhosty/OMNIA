const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'web');
const template = fs.readFileSync(path.join(root, 'tool.html'), 'utf8');
const videoAccept =
  '.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.mpeg,.mpg,.ts,.gif,.mts,.m2ts,.3gp,.3g2,.vob,.flv';
const tools = [
  {
    TOOL: 'mp3',
    TITLE: 'MP3 converter',
    EYEBROW: 'MP3 TOOL',
    DESCRIPTION: 'Convert audio and video files.',
    NUMBER: '001',
    INSIGNIA: 'audio',
    OUTPUT: 'MP3',
    ACCEPT: videoAccept + ',.m4a,.wav,.mp3,.flac,.ogg,.opus,.aac,.wma,.aif,.aiff,.amr',
    partial: 'audio',
    file: 'index.html',
  },
  {
    TOOL: 'mp4',
    TITLE: 'MP4 converter',
    EYEBROW: 'MP4 TOOL',
    DESCRIPTION: 'Convert videos to MP4.',
    NUMBER: '002',
    INSIGNIA: 'video',
    OUTPUT: 'MP4',
    ACCEPT: videoAccept,
    partial: 'video',
    file: 'mp4.html',
  },
  {
    TOOL: 'gif',
    TITLE: 'GIF converter',
    EYEBROW: 'GIF TOOL',
    DESCRIPTION: 'Make GIFs from images and videos.',
    NUMBER: '003',
    INSIGNIA: 'gif',
    OUTPUT: 'GIF',
    ACCEPT: videoAccept + ',.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff',
    partial: 'gif',
    file: 'gif.html',
  },
];
for (const config of tools) {
  config.FORMATS = (
    config.TOOL === 'gif'
      ? ['PNG', 'JPG', 'WEBP', 'MP4', '+ MORE']
      : config.TOOL === 'mp3'
        ? ['MP4', 'MOV', 'WAV', 'FLAC', '+ MORE']
        : ['MP4', 'MOV', 'MKV', 'WEBM', '+ MORE']
  ).join(' <b>·</b> ');
  config.OPTIONS = fs.readFileSync(path.join(root, 'partials', config.partial + '.html'), 'utf8');
  if (config.TOOL !== 'gif') {
    config.OPTIONS += fs.readFileSync(path.join(root, 'partials', 'editing.html'), 'utf8');
    if (config.TOOL === 'mp3') config.ACCEPT += ',.mka,.ac3,.eac3,.ape,.wv,.caf,.au,.tta';
    else {
      const crop = fs
        .readFileSync(path.join(root, 'partials', 'gif.html'), 'utf8')
        .split('</div><div class="option-grid"><label>OUTPUT WIDTH')[0];
      config.OPTIONS +=
        '<details class="media-editing"><summary>Trim, crop &amp; orientation</summary>' +
        crop
          .replace('aria-label="GIF options"', 'aria-label="Video editing"')
          .replace('.GIF', '.MP4') +
        '</div><span id="gif-frame-rate" hidden></span><p id="gif-note" class="option-note">Crop uses the original frame before rotation.</p></section><div class="option-grid"><label>ROTATION<select id="video-rotate"><option value="0">Original</option><option value="90">90° clockwise</option><option value="180">180°</option><option value="270">90° counterclockwise</option></select></label><label>FLIP<select id="video-flip"><option value="none">None</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option></select></label><label>AUDIO<select id="video-mute"><option value="no">Keep audio</option><option value="yes">Mute</option></select></label></div></details>';
    }
  }
  fs.writeFileSync(
    path.join(root, config.file),
    template.replace(/\{\{(\w+)\}\}/g, (_, key) => config[key] ?? ''),
  );
}
console.log('Generated three matching converter pages.');
