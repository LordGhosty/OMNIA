// Tool insignias.
const insigniaDesigns = {
  key: () =>
    makeSVG(
      'insignia-key',
      '<g class="key-turn"><circle cx="49" cy="26" r="17"/><circle cx="49" cy="26" r="6"/><path d="m61 38 28 23 8-9-7-6 6-7-7-6-7 7-11-10"/></g>',
    ),
  diskspace: () =>
    makeSVG(
      'insignia-diskspace',
      '<rect x="22" y="24" width="96" height="20" rx="2"/><svg x="24" y="26" width="92" height="16" viewBox="0 0 92 16" class="storage-window"><rect width="92" height="16" fill="#383838" stroke="none"/><path class="storage-volume storage-volume-a" d="M0 0h21v16H0z"/><path class="storage-volume storage-volume-b" d="M22 0h30v16H22z"/><path class="storage-volume storage-volume-c" d="M53 0h24v16H53z"/></svg>',
    ),
  repair: () =>
    makeSVG(
      'insignia-repair',
      '<g class="repair-wrench"><path stroke-linejoin="round" d="M79 10a17 17 0 0 0-20 22L37 54a5 5 0 0 0 7 7l22-22a17 17 0 0 0 22-20L77 30l-9-9z"/><circle cx="42" cy="56" r="1.6"/></g><g class="repair-turn"><circle cx="100" cy="47" r="8"/><circle cx="100" cy="47" r="3"/><path d="M100 34v5m0 16v5M87 47h5m16 0h5m-22-9 4 4m10 10 4 4m-18 0 4-4m10-10 4-4"/></g>',
    ),
  firewall: () =>
    makeSVG(
      'insignia-firewall',
      '<path d="M70 7 96 17v18c0 12-15 22-26 27-11-5-26-15-26-27V17z"/><g class="firewall-wall" stroke-linecap="square"><path d="M51 25h38M51 35h38M56 45h28M62 18v7m16-7v7M70 25v10M60 35v10m20-10v10M70 45v10"/></g>',
    ),
  rename: () =>
    makeSVG(
      'insignia-rename',
      '<path d="M32 21h51M32 34h35M32 47h51"/><g class="rename-cursor"><path d="M91 17v35m-6-35h12m-12 35h12"/></g>',
    ),
  duplicates: () =>
    makeSVG(
      'insignia-duplicates',
      '<rect x="34" y="10" width="42" height="45" rx="2"/><g class="duplicate-sheet"><rect x="64" y="18" width="42" height="45" rx="2" fill="#121211"/><path d="M74 31h22M74 40h22M74 49h15"/></g>',
    ),
  search: () =>
    makeSVG(
      'insignia-search',
      '<path d="M28 18h32M28 30h24M28 42h32"/><g class="search-lens"><circle cx="86" cy="30" r="17"/><path d="m98 43 17 17"/></g>',
    ),
  driver: () =>
    makeSVG(
      'insignia-driver',
      '<rect x="49" y="13" width="42" height="42" rx="3"/><path d="M58 6v7m12-7v7m12-7v7M58 55v7m12-7v7m12-7v7M42 23h7m-7 11h7m-7 11h7m42-22h7m-7 11h7m-7 11h7"/><path class="driver-scan" d="M57 25h26m-26 9h26m-26 9h26"/>',
    ),
  picture: () =>
    makeSVG(
      'insignia-picture',
      '<rect x="36" y="14" width="68" height="42"/><path d="m39 50 18-18 16 13 10-10 18 15"/><circle cx="85" cy="25" r="4"/><path class="picture-corners" d="M28 24V7h20m44 0h20v17M28 44v17h20m44 0h20V44"/>',
    ),
  metadata: () =>
    makeSVG(
      'insignia-metadata',
      '<path d="M35 10h52l16 16v33H35zM87 10v16h16"/><g><path class="metadata-line" d="M45 32h34"/><path class="metadata-line" d="M45 42h43"/><path class="metadata-line" d="M45 52h26"/></g>',
    ),
  inspect: () =>
    makeSVG(
      'insignia-inspect',
      '<path d="M39 10h35l16 16v34H39zM74 10v16h16M47 34h16m-16 9h11"/><g class="inspect-lens"><circle cx="85" cy="39" r="15"/><path d="m96 50 15 13"/></g>',
    ),
  globe: () =>
    makeSVG(
      'insignia-globe',
      '<circle cx="70" cy="34" r="27"/><ellipse cx="70" cy="34" rx="27" ry="11"/><path d="M43 34h54"/><g class="globe-meridian"><ellipse cx="70" cy="34" rx="16" ry="27"/></g><g class="globe-meridian globe-second"><ellipse cx="70" cy="34" rx="16" ry="27"/></g><path class="globe-land" d="m56 16 8-3 6 7-4 8-7 2-2 9 7 5-1 11-6-7-3-10-5-7 2-9z m24 16 9 3 3 9-8 7-6-5 2-7-4-2z"/>',
    ),
  speed: () => {
    const ticks = [-90, -45, 0, 45, 90]
      .map((angle) => `<path d="M70 19v6" transform="rotate(${angle} 70 48)"/>`)
      .join('');
    return makeSVG(
      'insignia-speed',
      `<path d="M37 48a33 33 0 0 1 66 0"/>${ticks}<path class="speed-needle" d="M70 48 90 27"/><circle cx="70" cy="48" r="3"/>`,
    );
  },
  audio: () => {
    const wave = document.createElement('span');
    wave.className = 'waveform';
    for (let i = 0; i < 27; i++) wave.append(document.createElement('i'));
    return wave;
  },
  video: () => {
    // Repeating film frames.
    const frames = Array.from({ length: 4 }, (_, i) => {
      const holes = Array.from(
        { length: 4 },
        (_, j) =>
          `<rect x="${j * 9 + 2}" y="2" width="4" height="4"/><rect x="${j * 9 + 2}" y="42" width="4" height="4"/>`,
      ).join('');
      return `<g transform="translate(${i * 36} 0)"><rect class="film-frame" x="3" y="10" width="29" height="28" rx="3"/><g class="film-holes">${holes}</g></g>`;
    }).join('');
    return makeSVG(
      'insignia-film',
      `<path class="film-rails" d="M18 10h104M18 58h104"/><svg class="film-window" x="18" y="10" width="104" height="48" viewBox="0 0 104 48"><g class="film-track">${frames}</g></svg>`,
    );
  },
  gif: () =>
    makeSVG(
      'insignia-gif',
      '<rect class="gif-back" x="25" y="10" width="67" height="38"/><rect class="gif-middle" x="35" y="16" width="67" height="38"/><rect class="gif-front" x="45" y="22" width="67" height="38"/><path class="gif-corners" d="M53 34v-4h7m36 0h8v5M53 48v4h7m36 0h8v-4"/><path class="gif-loop" d="M70 39a8 8 0 1 1 1 9m-1-9h7m-7 0v-6"/>',
    ),
  drive: () =>
    makeSVG(
      'insignia-drive',
      '<rect x="43" y="24" width="54" height="34" rx="3"/><path d="M54 24V9h32v15M64 14v5m12-5v5M52 40h36"/><circle class="drive-indicator" cx="83" cy="49" r="2" fill="currentColor"/>',
    ),
  files: () => makeSymbol('files', '▱'),
  code: () => makeSymbol('code', '</>'),
  image: () => makeSymbol('image', '▧'),
};
function makeSVG(className, markup) {
  const wrapper = document.createElement('span');
  wrapper.className = 'insignia-vector ' + className;
  wrapper.innerHTML = `<svg viewBox="0 0 140 68" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${markup}</svg>`;
  return wrapper;
}
function makeSymbol(kind, text) {
  const symbol = document.createElement('span');
  symbol.className = `insignia-symbol insignia-${kind}`;
  symbol.textContent = text;
  return symbol;
}
const insigniaVisibility = new IntersectionObserver((entries) => {
  for (const entry of entries)
    entry.target.classList.toggle('insignia-offscreen', !entry.isIntersecting);
});
document.querySelectorAll('[data-insignia]').forEach((host) => {
  const design = insigniaDesigns[host.dataset.insignia];
  if (design) host.replaceChildren(design());
  host.classList.add('insignia-offscreen');
  insigniaVisibility.observe(host);
});
