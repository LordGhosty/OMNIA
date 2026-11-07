const { contextBridge, ipcRenderer, webUtils } = require('electron');
let dirty = false;
let cancelMotion, finishMotion;
ipcRenderer.on('omnia:settings-state', (_event, state) => {
  if (!state.enabled || !state.transitions) finishMotion?.();
});
ipcRenderer.on('omnia:settings-dismiss', () =>
  window.dispatchEvent(new Event('omnia:settings-dismiss')),
);
for (const type of ['mousedown', 'mouseup', 'auxclick'])
  addEventListener(
    type,
    (event) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === 'mouseup')
        ipcRenderer.send('omnia:history', event.button === 3 ? 'back' : 'forward');
    },
    true,
  );
ipcRenderer.on('omnia:motion', (_event, plan) => {
  cancelMotion?.();
  const target = document.querySelector('.native-scroll');
  if (!target) return;
  let frame,
    deadline,
    animation,
    finished = false;
  const finish = () => {
    if (finished) return;
    cancelMotion();
    target.style.transform = plan.leaving ? 'translate3d(-100%,0,0)' : '';
    target.style.willChange = '';
    ipcRenderer.send('omnia:motion-frame', plan.id, 1);
  };
  finishMotion = finish;
  const hidden = () => {
    if (document.hidden) finish();
  };
  cancelMotion = () => {
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(deadline);
    animation?.cancel();
    document.removeEventListener('visibilitychange', hidden);
  };
  if (!plan.duration || document.hidden) return finish();
  target.style.willChange = 'transform';
  animation = target.animate(
    [
      { transform: plan.leaving ? 'translate3d(0,0,0)' : 'translate3d(-100%,0,0)' },
      { transform: plan.leaving ? 'translate3d(-100%,0,0)' : 'translate3d(0,0,0)' },
    ],
    { duration: plan.duration, easing: 'cubic-bezier(.333333,1,.666667,1)', fill: 'forwards' },
  );
  const tick = () => {
    if (finished) return;
    ipcRenderer.send(
      'omnia:motion-frame',
      plan.id,
      Math.min(1, (animation.currentTime || 0) / plan.duration),
    );
    frame = requestAnimationFrame(tick);
  };
  animation.onfinish = finish;
  document.addEventListener('visibilitychange', hidden);
  // Occluded native views may suspend compositor callbacks without a visibility event.
  deadline = setTimeout(finish, plan.duration + 250);
  frame = requestAnimationFrame(tick);
});
if (!['/launcher.html', '/', '/desktop'].includes(new URL(location.href).pathname)) {
  setInterval(() => ipcRenderer.send('omnia:tool-heartbeat', dirty), 1000);
  addEventListener(
    'input',
    (event) => {
      if (!event.target.closest?.('#settings-panel')) dirty = true;
    },
    true,
  );
  addEventListener('drop', () => (dirty = true), true);
  addEventListener(
    'click',
    (event) => {
      if (!event.target.closest?.('#settings-panel') && event.target.closest?.('button,input,a'))
        dirty = true;
    },
    true,
  );
  ipcRenderer.on('omnia:tool-visible', () => window.dispatchEvent(new Event('omnia:page-visible')));
}
contextBridge.exposeInMainWorld('omnia', {
  isolated: true,
  settings: (action, data) => ipcRenderer.invoke('omnia:settings', action, data),
  onSettings: (callback) =>
    ipcRenderer.on('omnia:settings-state', (_event, state) => callback(state)),
  onSettingsOpen: (callback) =>
    ipcRenderer.on('omnia:settings-open', (_event, data) => callback(data)),
  toolInfo: () => ipcRenderer.invoke('omnia:tool-info'),
  toolActivity: () => ipcRenderer.invoke('omnia:tool-activity'),
  onToolActivity: (callback) =>
    ipcRenderer.on('omnia:tool-activity', (_event, state) => callback(state)),
  toolView: (action, data) => ipcRenderer.invoke('omnia:tool-view', action, data),
  onToolTransition: (callback) =>
    ipcRenderer.on('omnia:tool-transition', (_event, state) => callback(state)),
  toolHealth: (action, data) => ipcRenderer.invoke('omnia:tool-health', action, data),
  onToolHealth: (callback) =>
    ipcRenderer.on('omnia:tool-health', (_event, state) => callback(state)),
  ssh: (action, data) => {
    if (action === 'drop') throw Error('Drop a key from your computer.');
    return ipcRenderer.invoke('omnia:ssh', action, data);
  },
  dropKey: (files) => {
    const paths = Array.from(files, (file) => webUtils.getPathForFile(file));
    if (paths.length !== 1 || !paths[0]) throw Error('Drop one key from your computer.');
    return ipcRenderer.invoke('omnia:ssh', 'drop', { paths });
  },
  fileTools: (action, data) => {
    if (action === 'drop') throw Error('Drop files from your computer.');
    return ipcRenderer.invoke('omnia:file-tools', action, data);
  },
  dropManagedFiles: (tool, files) => {
    const paths = Array.from(files, (file) => webUtils.getPathForFile(file));
    if (!paths.length || paths.some((p) => !p)) throw Error('Drop files from your computer.');
    return ipcRenderer.invoke('omnia:file-tools', 'drop', { tool, paths });
  },
  diskspace: (action, data) => ipcRenderer.invoke('omnia:diskspace', action, data),
  firewall: (action, data) => ipcRenderer.invoke('omnia:firewall', action, data),
  repair: (action, data) => ipcRenderer.invoke('omnia:repair', action, data),
  drivers: (action, data) => ipcRenderer.invoke('omnia:drivers', action, data),
  dropFiles: (tool, files) => {
    const paths = Array.from(files, (file) => webUtils.getPathForFile(file));
    if (!paths.length || paths.some((file) => !file)) throw Error('Drop files from your computer.');
    return ipcRenderer.invoke('omnia:files', 'drop', { tool, paths });
  },
  files: (action, data) => {
    if (action === 'drop') throw Error('Drop files from your computer.');
    return ipcRenderer.invoke('omnia:files', action, data);
  },
  validation: () => ipcRenderer.invoke('omnia:validation'),
  onValidation: (callback) =>
    ipcRenderer.on('omnia:validation-state', (_event, state) => callback(state)),
  openTool: (tool) => ipcRenderer.invoke('omnia:open', tool),
  navigateHistory: (direction) => ipcRenderer.invoke('omnia:history', direction),
  onNavigate: (callback) => ipcRenderer.on('omnia:navigate', (_event, tool) => callback(tool)),
  onBack: (callback) => ipcRenderer.on('omnia:back', () => callback()),
  admin: (action) => ipcRenderer.invoke('omnia:admin', action),
  onAdmin: (callback) => ipcRenderer.on('omnia:admin-state', (_event, state) => callback(state)),
  drives: (action, data) => ipcRenderer.invoke('omnia:drives', action, data),
  onDrives: (callback) => ipcRenderer.on('omnia:drives-state', (_event, state) => callback(state)),
  onNotice: (callback) => ipcRenderer.on('omnia:notice', (_event, text) => callback(text)),
  networkSettings: () => ipcRenderer.invoke('omnia:network-settings'),
  copyText: (text) => ipcRenderer.invoke('omnia:copy', text),
  updates: (action) => ipcRenderer.invoke('omnia:updates', action),
  onUpdate: (callback) => ipcRenderer.on('omnia:update', (_event, state) => callback(state)),
  minimize: () => ipcRenderer.send('omnia:minimize'),
  close: () => ipcRenderer.send('omnia:close'),
  expand: (reduced) => ipcRenderer.invoke('omnia:expand', Boolean(reduced)),
  expandFrame: (progress) => ipcRenderer.send('omnia:expand-frame', progress),
  onExpanded: (callback) => ipcRenderer.once('omnia:expanded', () => callback()),
});
