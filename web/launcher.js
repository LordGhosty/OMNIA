const reduced = () =>
  !(
    window.omniaSettings?.enabled('transitions') ??
    !matchMedia('(prefers-reduced-motion: reduce)').matches
  );
const validationDialog = document.querySelector('#validation-dialog');
function validationState(state) {
  const badge = document.querySelector('#validation-status');
  const labels = {
    validated: 'VALIDATED SOFTWARE',
    checking: 'CHECKING SOFTWARE',
    unvalidated: 'UNVALIDATED SOFTWARE',
  };
  badge.textContent = labels[state.state] || labels.unvalidated;
  badge.dataset.state = labels[state.state] ? state.state : 'unvalidated';
  document.querySelector('#validation-reason').textContent =
    state.reason || 'Authenticity could not be established.';
  const details = document.querySelector('#validation-details');
  details.replaceChildren();
  for (const [label, value] of [
    ['Publisher', state.publisher],
    ['Version', state.version],
    ['Files checked', state.files],
    ['Checked', state.checkedAt && new Date(state.checkedAt).toLocaleString()],
    ['Release key SHA-256', state.keyFingerprint],
  ])
    if (value) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = String(value);
      details.append(dt, dd);
    }
}
document
  .querySelector('#validation-status')
  .addEventListener('click', () => validationDialog.showModal());
document
  .querySelector('#close-validation')
  .addEventListener('click', () => validationDialog.close());
if (window.omnia) {
  window.omnia.onValidation(validationState);
  window.omnia
    .validation()
    .then(validationState)
    .catch(() =>
      validationState({
        state: 'unvalidated',
        reason: 'The native verification service is unavailable.',
      }),
    );
} else
  validationState({
    state: 'unvalidated',
    reason: 'Browser previews cannot verify the installed application.',
  });
const logoReady = fetch('/logo.txt')
  .then((r) => r.text())
  .then((text) => {
    const logo = document.querySelector('.ascii');
    const original = text.replace(/\r?\n$/, '');
    const source = document.createElement('span');
    source.className = 'ascii-source';
    source.textContent = original;
    logo.replaceChildren(source);
    const lines = original.split(/\r?\n/);
    const width = Math.max(...lines.map((line) => line.trimEnd().length));
    logo.style.width = `${width}ch`;
    const columns = [0, 9, 19, 29, 33, 42, 48, 57, 66, 75, width];
    for (let i = 0; i < columns.length - 1; i++) {
      const letter = document.createElement('span');
      letter.className = 'ascii-letter';
      letter.setAttribute('aria-hidden', 'true');
      letter.dataset.glyph = lines.map((line) => line.slice(columns[i], columns[i + 1])).join('\n');
      letter.style.left = columns[i] + 'ch';
      letter.style.animationDelay = -i * 0.22 + 's';
      logo.append(letter);
    }
  })
  .catch(() => {
    document.querySelector('.ascii').textContent = 'OMNIA';
  });
let introStarted = false,
  introTimer;
const visible = () => !window.omnia || (document.hasFocus() && !document.hidden);
async function expandWindow() {
  const animation = window.omnia
    ? await window.omnia.expand(reduced())
    : { duration: reduced() ? 0 : 850 };
  if (!animation) return;
  document.body.classList.add('expanding');
  document.body.classList.remove('booting');
  if (!window.omnia) {
    setTimeout(() => document.body.classList.remove('expanding'), animation.duration);
    return;
  }
  if (!animation.duration) {
    await window.omnia.expandFrame(1);
    return;
  }
  let started;
  const frame = (now) => {
    started ??= now;
    const progress = reduced() ? 1 : Math.min(1, (now - started) / animation.duration);
    window.omnia.expandFrame(progress);
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
async function startIntro() {
  if (new URLSearchParams(location.search).has('return')) {
    introStarted = true;
    document.body.classList.add('returning');
    document.body.classList.remove('booting');
    return;
  }
  if (introStarted || introTimer || !visible()) return;
  await logoReady;
  await window.omniaSettings?.ready;
  await document.fonts.ready;
  if (introStarted || introTimer || !visible()) return;
  introTimer = setTimeout(
    () => {
      introTimer = null;
      if (!visible()) return;
      introStarted = true;
      void expandWindow();
    },
    reduced() ? 0 : 1500,
  );
}
function pauseIntro() {
  if (!introStarted && introTimer) {
    clearTimeout(introTimer);
    introTimer = null;
  }
}
window.addEventListener('blur', pauseIntro);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseIntro();
});
window.addEventListener('focus', startIntro);
document.addEventListener('visibilitychange', startIntro);
void startIntro();
window.omnia?.onExpanded(() => document.body.classList.remove('expanding'));
function setView(view) {
  document
    .querySelectorAll('.tool-directory')
    .forEach((directory) => (directory.dataset.layout = view));
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  try {
    localStorage.setItem('omnia-directory-view', view);
  } catch {}
}
document
  .querySelectorAll('[data-view]')
  .forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
try {
  if (localStorage.getItem('omnia-directory-view') === 'list') setView('list');
} catch {}
document.querySelector('#minimize').addEventListener('click', () => window.omnia?.minimize());
document.querySelector('#close').addEventListener('click', () => window.omnia?.close());
document.querySelectorAll('[data-tool]').forEach((button) =>
  button.addEventListener('click', async () => {
    try {
      if (window.omnia) await window.omnia.openTool(button.dataset.tool);
      else await window.omniaRouter.open(button.dataset.tool);
    } catch (error) {
      window.alert(error.message || 'Could not open this tool. Try again.');
    }
  }),
);
const updateDialog = document.querySelector('#updates-dialog');
function updateState(state) {
  document.querySelector('#update-status').textContent = state.message;
  document.querySelector('#check-updates').disabled =
    !state.configured || !['idle', 'available', 'error'].includes(state.state);
  document.querySelector('#download-update').hidden = state.state !== 'available';
  document.querySelector('#install-update').hidden = state.state !== 'downloaded';
  document
    .querySelector('#updates')
    .classList.toggle('update-available', ['available', 'downloaded'].includes(state.state));
}
document.querySelector('#updates').addEventListener('click', async () => {
  updateDialog.showModal();
  updateState(
    window.omnia
      ? await window.omnia.updates('status')
      : { configured: false, message: 'Updates are available in the installed app.' },
  );
});
document.querySelector('#close-updates').addEventListener('click', () => updateDialog.close());
for (const [id, action] of [
  ['check-updates', 'check'],
  ['download-update', 'download'],
  ['install-update', 'install'],
])
  document.querySelector('#' + id).addEventListener('click', async () => {
    try {
      updateState(await window.omnia.updates(action));
    } catch (error) {
      document.querySelector('#update-status').textContent = error.message;
    }
  });
window.omnia?.onUpdate(updateState);
const shield = document.querySelector('#admin-shield');
function adminState(state) {
  shield.disabled = !state.supported || state.state === 'requesting';
  shield.setAttribute('aria-pressed', String(state.enabled));
  shield.title = state.enabled
    ? 'Administrator session active · click to end'
    : 'Enable administrator session';
  shield.setAttribute('aria-label', shield.title);
}
shield.addEventListener('click', async () => {
  try {
    shield.disabled = true;
    const state = await window.omnia.admin('status');
    adminState(await window.omnia.admin(state.enabled ? 'disable' : 'enable'));
  } catch (error) {
    window.omniaRouter.message(error.message);
    adminState(await window.omnia.admin('status'));
  }
});
function driveState(state) {
  document.querySelector('[data-tool=drives]').hidden = !state.disks.length;
  window.refreshDirectory();
}
if (window.omnia) {
  window.omnia.onAdmin(adminState);
  window.omnia.admin('status').then(adminState);
  window.omnia.onDrives(driveState);
  window.omnia
    .drives('status')
    .then(driveState)
    .catch(() => {});
} else adminState({ supported: false });
