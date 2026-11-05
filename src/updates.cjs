const config = require('../assets/updates.json');
/** Checks the configured release feed and defers installation while tool operations are active. */
function createUpdates({
  app,
  window,
  isBusy,
  recovery,
  settings = config,
  platform = process.platform,
  verify = (file) =>
    require('./validation.cjs').checkWindowsSignature(
      file,
      require('../assets/release-trust.json'),
    ),
  updaterFactory,
  automaticCheck = true,
}) {
  let updater;
  let downloadedFile;
  const verifyDownloaded = async (file) => {
    if (platform === 'win32') await verify(file);
  };
  let state = {
    configured: false,
    state: 'disabled',
    message: `Version ${app.getVersion()}. Updates are not configured.`,
  };
  const send = (next) => {
    state = { ...state, ...next };
    if (!window.isDestroyed()) window.webContents.send('omnia:update', state);
    return state;
  };
  if (
    settings.enabled &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(settings.repository) &&
    app.isPackaged
  ) {
    const [owner, repo] = settings.repository.split('/');
    if (updaterFactory) updater = updaterFactory({ owner, repo });
    else {
      const { NsisUpdater, AppImageUpdater } = require('electron-updater');
      updater =
        platform === 'win32'
          ? new NsisUpdater({ provider: 'github', owner, repo })
          : platform === 'linux'
            ? new AppImageUpdater({ provider: 'github', owner, repo })
            : null;
    }
    if (updater) {
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      updater.allowPrerelease = false;
      state = { configured: true, state: 'idle', message: `Version ${app.getVersion()}.` };
      updater.on('checking-for-update', () =>
        send({ state: 'checking', message: 'Checking for updates…' }),
      );
      updater.on('update-available', (info) =>
        send({ state: 'available', message: `Version ${info.version} is available.` }),
      );
      updater.on('update-not-available', () =>
        send({ state: 'idle', message: `Version ${app.getVersion()} is up to date.` }),
      );
      updater.on('download-progress', (progress) =>
        send({
          state: 'downloading',
          message: `Downloading update · ${Math.round(progress.percent)}%`,
        }),
      );
      updater.on('update-downloaded', async (info) => {
        downloadedFile = null;
        send({ state: 'verifying', message: 'Verifying the update publisher…' });
        try {
          if (!info.downloadedFile) throw Error('No downloaded update');
          await verifyDownloaded(info.downloadedFile);
          downloadedFile = info.downloadedFile;
          send({
            state: 'downloaded',
            message: 'Update ready. Restart when your conversions are finished.',
          });
        } catch {
          send({
            state: 'error',
            message: 'The update publisher could not be verified. Installation is blocked.',
          });
        }
      });
      updater.on('error', () =>
        send({ state: 'error', message: 'Could not retrieve the update. Try again later.' }),
      );
      if (automaticCheck) {
        const timer = setTimeout(() => {
          void updater.checkForUpdates().catch(() => {});
        }, 15000);
        timer.unref();
      }
    }
  }
  return async (action) => {
    if (!updater || action === 'status') return state;
    try {
      if (action === 'check' && ['idle', 'available', 'error'].includes(state.state)) {
        void updater.checkForUpdates().catch(() => {});
      }
      if (action === 'download' && state.state === 'available') {
        send({ state: 'downloading', message: 'Downloading update…' });
        void updater.downloadUpdate().catch(() => {});
      }
      if (action === 'install' && state.state === 'downloaded') {
        if (isBusy())
          return {
            ...state,
            message: 'Finish or cancel the current conversion before installing.',
          };
        if (!downloadedFile) throw Error('No verified update');
        send({ state: 'verifying', message: 'Verifying the update publisher…' });
        await verifyDownloaded(downloadedFile);
        if (platform !== 'win32')
          throw Error(
            'Automatic recovery is not configured on this platform. Install releases manually for now.',
          );
        send({ state: 'preparing-recovery', message: 'Saving a verified recovery installer…' });
        await recovery.prepare();
        if (isBusy()) {
          send({
            state: 'downloaded',
            message: 'Recovery is ready. Finish active operations before installing.',
          });
          return state;
        }
        await verifyDownloaded(downloadedFile);
        // Recheck after signature verification, which can await online certificate checks.
        setImmediate(() => {
          if (isBusy())
            send({ state: 'downloaded', message: 'Finish active operations before installing.' });
          else updater.quitAndInstall(false, true);
        });
      }
    } catch (error) {
      send({
        state: 'error',
        message: error.message || 'Could not complete the update. Try again later.',
      });
    }
    return state;
  };
}
module.exports = { createUpdates };
