const fs = require('node:fs');
const path = require('node:path');
const rename = `<section class="network-panel" id="rename-rules">
  <div class="panel-title">02 / CHOOSE THE NEW NAMES</div>
  <label class="rename-operation">WHAT WOULD YOU LIKE TO DO?<select id="rename-mode"><option value="text">Add text</option><option value="replace">Replace text</option><option value="number">Number files</option><option value="case">Change letter case</option><option value="custom">Custom pattern</option></select></label>
  <div class="system-form rename-fields">
    <label data-rename-mode="text custom">TEXT BEFORE THE NAME<input id="rename-prefix" maxlength="100"></label>
    <label data-rename-mode="text custom">TEXT AFTER THE NAME<input id="rename-suffix" maxlength="100"></label>
    <label data-rename-mode="replace custom" hidden>TEXT TO FIND<input id="rename-find" maxlength="100"></label>
    <label data-rename-mode="replace custom" hidden>REPLACE WITH<input id="rename-replace" maxlength="100"></label>
    <label data-rename-mode="number" hidden>BASE NAME<input id="rename-base" maxlength="100" placeholder="Leave blank to keep each name"></label>
    <label data-rename-mode="custom" class="wide" hidden>NAME PATTERN<input id="rename-pattern" value="{name}" maxlength="240"><span class="option-note">{name} = original name · {n} = number · {date} = modified date (UTC)</span></label>
    <label data-rename-mode="number custom" hidden>START AT<input id="rename-start" type="number" min="0" value="1"></label>
    <label data-rename-mode="number custom" hidden>NUMBER LENGTH<select id="rename-padding"><option value="1">1, 2, 3…</option><option value="2">01, 02, 03…</option><option value="3" selected>001, 002, 003…</option><option value="4">0001, 0002, 0003…</option></select></label>
    <label data-rename-mode="case custom" hidden>LETTER CASE<select id="rename-case"><option value="keep">Keep current case</option><option value="lower">lowercase</option><option value="upper">UPPERCASE</option></select></label>
  </div>
  <p class="option-note">File extensions stay unchanged. Nothing is renamed until you review and apply the changes.</p>
  <div id="rename-example" class="rename-example" aria-live="polite">Choose files or a folder to preview your new names.</div>
  <div class="system-toolbar"><button id="rename-preview" disabled>Preview names →</button></div>
  <details class="network-details"><summary>Rename history &amp; undo</summary><div id="rename-history"></div></details>
</section>`;
const location = `<aside class="network-panel location-panel">
  <div class="panel-title">LOCATIONS<button id="locations-refresh" class="location-refresh" aria-label="Refresh locations">↻</button></div>
  <p class="option-note">Tick a location to include it. Expand a folder to look inside.</p>
  <nav id="location-tree" aria-label="Folders and drives">Finding locations…</nav>
  <form id="location-address"><label for="location-path">FOLDER PATH</label><div><input id="location-path" placeholder="Paste a full folder path" autocomplete="off"><button id="location-add" type="submit" aria-label="Add folder path">+</button></div></form>
  <div class="system-toolbar"><button id="choose-folders">Browse folders…</button><button id="choose-files">Add files…</button></div>
</aside>`;
const search = `<label class="search-query">FIND BY NAME<input id="filter-name" type="search" maxlength="240" placeholder="Type a name or pattern, such as *.pdf" autocomplete="off"></label>
  <p class="option-note">Type part of a name, or use * for any text and ? for one character. Press Enter to search.</p>
  <details class="network-details search-help"><summary>Pattern examples</summary><dl><dt>report</dt><dd>Names containing “report”</dd><dt>report*.pdf</dt><dd>PDFs starting with “report”</dd><dt>photo-??.jpg</dt><dd>Exactly two characters after “photo-”</dd><dt>*.jpg | *.png</dt><dd>Either pattern</dd><dt>"report.pdf"</dt><dd>An exact filename</dd></dl></details>`;
for (const tool of require('../assets/tools.json').filter((t) =>
  ['rename', 'duplicates', 'search'].includes(t.id),
)) {
  const isRename = tool.id === 'rename',
    isSearch = tool.id === 'search';
  const filters = `<details class="network-details file-filters"><summary>Filters &amp; options</summary><div class="system-form">
    <label>FILE TYPES<input id="filter-extensions" placeholder="All types, or jpg, pdf, txt"></label>
    ${isSearch ? `<label>SHOW<select id="filter-kind"><option value="all">Files and folders</option><option value="files">Files only</option><option value="folders">Folders only</option></select></label><label>NAME MATCHING<select id="filter-match"><option value="auto">Automatic</option><option value="contains">Contains text</option><option value="wildcard">Wildcard pattern</option><option value="exact">Exact name</option></select></label><label class="file-checkbox"><input id="filter-case" type="checkbox">Match letter case</label><label>MODIFIED FROM (UTC)<input id="filter-after" type="date"></label><label>MODIFIED THROUGH (UTC)<input id="filter-before" type="date"></label>` : ''}
    <label class="wide">EXCLUDE NAMES<input id="filter-exclude" maxlength="240" placeholder="Optional names or patterns, separated by |"><span class="option-note">Matching folders and everything inside them are skipped.</span></label>
    ${!isRename ? '<label>MINIMUM SIZE (MiB)<input id="filter-min" type="number" min="0" step="any"></label><label>MAXIMUM SIZE (MiB)<input id="filter-max" type="number" min="0" step="any"></label>' : ''}
  </div></details>`;
  const drop = `<button class="drop-zone" id="file-drop" type="button"><span class="file-symbol" aria-hidden="true">↥</span><span class="drop-title">Drop files or folders here</span><span class="drop-description">or click to browse ${isRename ? 'files' : 'folders'}</span><span class="format-strip">FILES <b>·</b> FOLDERS</span><span class="corner tl" aria-hidden="true"></span><span class="corner tr" aria-hidden="true"></span><span class="corner bl" aria-hidden="true"></span><span class="corner br" aria-hidden="true"></span></button>`;
  const source = `<section class="network-panel file-source"><div class="panel-title">${isRename ? '01 / CHOOSE FILES' : 'SEARCH LOCATIONS'}</div>
    <p id="scope-empty" class="option-note">Choose a folder or drive on the left, or use Browse folders.</p><ul id="file-scopes" class="file-scopes"></ul>

    ${isSearch ? search : ''}${filters}
    <label class="file-checkbox"><input id="file-recursive" type="checkbox" ${isRename ? '' : 'checked'}>Include subfolders</label>
    <div class="system-toolbar"><button id="scan-files" disabled>${isSearch ? 'Search' : isRename ? 'Load files' : 'Find duplicates'}</button><button id="cancel-files" disabled>Cancel</button><button id="clear-files">Clear</button></div>
    <p id="system-status" class="status-message" role="status">Choose a location to begin.</p><progress id="file-progress" hidden></progress>
    <p class="option-note">${isRename ? 'Files in the selected folders only, unless you include subfolders. You can rename up to 10,000 files per batch.' : isSearch ? 'Searches your selected locations directly. Results appear as they are found.' : 'Compares file contents, not just names. Scanning does not delete anything. Reading cloud-synced files may download them.'}</p>
    <details class="network-details"><summary>Scan details</summary><pre id="file-coverage"></pre></details>
  </section>`;
  const results = `<section class="network-panel" id="file-results" hidden><div class="panel-title">${tool.id === 'duplicates' ? 'DUPLICATE GROUPS' : isRename ? 'SELECTED FILES' : 'RESULTS'}<span id="file-count"></span></div>
    ${tool.id === 'duplicates' ? '<p class="option-note">Open a group to compare locations. Tick only the copies you want to remove; keep at least one. Review comes before removal.</p>' : ''}
    <div class="system-toolbar"><label>SORT<select id="file-sort"><option value="name">Name</option><option value="size">Largest first</option><option value="date">Newest first</option></select></label><button id="file-export">Export results</button>${tool.id === 'duplicates' ? '<button id="trash-preview" disabled>Review selected copies</button><span id="selected-count" class="option-note">0 selected</span>' : ''}</div><div id="duplicate-groups"></div>
    <div class="system-table-wrap"><table class="system-table"><thead><tr>${tool.id === 'duplicates' ? '<th>REMOVE</th>' : ''}<th>NAME / LOCATION</th><th>SIZE</th><th>MODIFIED</th><th></th></tr></thead><tbody id="file-rows"></tbody></table></div><div class="system-toolbar"><button id="file-prev">Previous</button><span id="file-page" class="option-note"></span><button id="file-next">Next</button></div></section>`;
  const review = `<dialog class="system-dialog file-review" id="file-review"><div class="panel-title">REVIEW FILE CHANGES</div><p id="file-review-summary"></p><p id="file-review-note" class="option-note"></p><div class="file-review-head"><span>BEFORE / ORIGINAL</span><span>AFTER / KEPT COPY</span></div><div id="file-review-rows"></div><div class="system-toolbar"><button id="review-prev">Previous</button><span id="review-page"></span><button id="review-next">Next</button></div><p id="file-review-error" class="system-error" role="alert"></p><div class="dialog-actions"><button id="review-cancel">Cancel</button><button id="review-apply">Apply</button></div></dialog>`;
  fs.writeFileSync(
    path.join(__dirname, '../web', tool.page),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${tool.name} — OMNIA</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/network.css"><link rel="stylesheet" href="/system-tools.css"><link rel="stylesheet" href="/file-tools.css"><script src="/app-shell.js" defer></script><link rel="stylesheet" href="/settings.css"><script src="/settings.js" defer></script><script src="/insignia.js" defer></script><script src="/admin-indicators.js" defer></script><script src="/system-tools.js" defer></script><script src="/location-browser.js" defer></script><script src="/file-tools.js" defer></script></head><body class="converter" data-tool="${tool.id}"><header class="browser-header"><a class="wordmark" href="/" aria-label="OMNIA home"><img class="brand-icon" src="/icon.png" alt="">OMNIA <span class="muted">/ FILES &amp; STORAGE</span></a><div class="page-insignia" data-insignia="${tool.insignia}" aria-label="${tool.name} insignia"></div></header><main class="workspace system-workspace file-workspace"><section class="converter-heading"><div><div class="eyebrow">FILES &amp; STORAGE</div><h1>${tool.name}<span class="cursor">_</span></h1><p>${tool.description}</p></div></section><div class="file-layout">${location.replace('</aside>', drop + '</aside>')}<div class="file-main">${source}${isRename ? rename : ''}${results}</div></div>${review}<footer class="browser-footer">OMNIA / A LITTLE BIT OF EVERYTHING, ALL OF THE TIME.</footer></main></body></html>`.replace(
      /^[ \t]+$/gm,
      '',
    ),
  );
}
console.log('Generated file tool pages.');
