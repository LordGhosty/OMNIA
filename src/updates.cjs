const config = require('../assets/updates.json');
/** Checks the configured release feed and defers installation while tool operations are active. */
function createUpdates({
  app,
  window,
  isBusy,
  recovery,
  settings = config,
  platform = process.platform,
  trust = require('../assets/release-trust.json'),
  verify,
  fetcher = fetch,
  updaterFactory,
  automaticCheck = true,
}) {
  let updater;
  let request;
  let downloadedFile;
  let downloadedVersion;
  let envelope;
  let feed;
  const ownKey = trust.mode === 'release-key' && !verify;
  const verifyDownloaded = async (file) => {
    if (platform !== 'win32') return;
    if (verify) return verify(file);
    if (trust.mode === 'release-key') {
      const { verifyArtifact, newer } = require('./release-signature.cjs');
      if (!newer(downloadedVersion, app.getVersion()))
        throw Error('The update version is not newer.');
      return verifyArtifact(file, envelope, trust, { version: downloadedVersion, fresh: true });
    }
    await require('./validation.cjs').checkWindowsSignature(file, trust);
  };
  let state = {
    configured: false,
    state: 'disabled',
    message: `Version ${app.getVersion()}. For this build, download updates from GitHub Releases.`,
  };
  const send = (next) => {
    state = { ...state, ...next };
    if (!window.isDestroyed() && !window.webContents.isDestroyed?.())
      window.webContents.send('omnia:update', state);
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
      updater.disableWebInstaller = true;
      if (trust.mode === 'release-key' && settings.repository !== trust.repository)
        throw Error('The update repository does not match the trusted release identity.');
      request = (action) => {
        if (action === 'check') {
          downloadedFile = null;
          send({ state: 'checking', message: 'Checking for updates…' });
        } else send({ state: 'downloading', message: 'Downloading update…' });
        void Promise.resolve()
          .then(async () => {
            if (action === 'check' && ownKey) {
              feed = null;
              const { fetchEnvelope, verifyMetadata, newer } = require('./release-signature.cjs');
              const signed = await fetchEnvelope(
                `https://github.com/${trust.repository}/releases/latest/download/OMNIA-update.json`,
                fetcher,
              );
              const data = verifyMetadata(signed, trust, { fresh: true });
              if (newer(app.getVersion(), data.version))
                throw Error('The update feed is older than this installation.');
              if (app.getPath) {
                const file = require('node:path').join(
                  app.getPath('userData'),
                  'update-version.json',
                );
                const { readJSON, writeJSON } = require('./recovery.cjs');
                const previous = await readJSON(file);
                if (previous?.version && newer(previous.version, data.version))
                  throw Error('The update feed moved backwards.');
                await writeJSON(file, { version: data.version });
              }
              feed = data;
            }
            return action === 'check' ? updater.checkForUpdates() : updater.downloadUpdate();
          })
          .catch(() =>
            send({ state: 'error', message: 'Could not retrieve the update. Try again later.' }),
          );
      };
      state = { configured: true, state: 'idle', message: `Version ${app.getVersion()}.` };
      updater.on('checking-for-update', () =>
        send({ state: 'checking', message: 'Checking for updates…' }),
      );
      updater.on('update-available', (info) => {
        if (ownKey && feed?.version !== info.version)
          return send({
            state: 'error',
            message: 'The update listing does not match the signed release.',
          });
        send({ state: 'available', message: `Version ${info.version} is available.` });
      });
      updater.on('update-not-available', () => {
        if (ownKey && feed?.version !== app.getVersion())
          return send({
            state: 'error',
            message: 'The update listing does not match the signed release.',
          });
        send({ state: 'idle', message: `Version ${app.getVersion()} is up to date.` });
      });
      updater.on('download-progress', (progress) =>
        send({
          state: 'downloading',
          message: `Downloading update · ${Math.round(progress.percent)}%`,
        }),
      );
      updater.on('update-downloaded', async (info) => {
        downloadedFile = null;
        send({ state: 'verifying', message: 'Verifying the release signature…' });
        try {
          if (!info.downloadedFile) throw Error('No downloaded update');
          downloadedVersion = info.version;
          if (!verify && trust.mode === 'release-key') {
            const { newer, fetchEnvelope } = require('./release-signature.cjs');
            if (!newer(info.version, app.getVersion())) throw Error('Invalid update version.');
            envelope = await fetchEnvelope(
              `https://github.com/${trust.repository}/releases/download/v${info.version}/OMNIA-${info.version}-Setup.exe.sig`,
              fetcher,
            );
          }
          await verifyDownloaded(info.downloadedFile);
          if (
            ownKey &&
            feed &&
            (feed.version !== downloadedVersion ||
              feed.sha256 !==
                require('./release-signature.cjs').verifyEnvelope(envelope, trust).sha256)
          )
            throw Error('The downloaded release changed after the update check.');
          downloadedFile = info.downloadedFile;
          send({
            state: 'downloaded',
            message: 'Update ready. Restart OMNIA to install it.',
          });
        } catch {
          send({
            state: 'error',
            message: 'The update signature could not be verified. Installation is blocked.',
          });
        }
      });
      updater.on('error', () =>
        send({ state: 'error', message: 'Could not retrieve the update. Try again later.' }),
      );
      if (automaticCheck) {
        const timer = setTimeout(() => {
          if (state.state === 'idle') request('check');
        }, 15000);
        timer.unref();
      }
    }
  }
  return async (action) => {
    if (!updater || action === 'status') return state;
    try {
      if (action === 'check' && ['idle', 'available', 'error'].includes(state.state)) {
        request('check');
      }
      if (action === 'download' && state.state === 'available') {
        request('download');
      }
      if (action === 'install' && state.state === 'downloaded') {
        if (isBusy())
          return {
            ...state,
            message: 'Finish or cancel active tool operations before installing.',
          };
        if (!downloadedFile) throw Error('No verified update');
        send({ state: 'verifying', message: 'Verifying the release signature…' });
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
          else {
            send({ state: 'installing', message: 'Restarting OMNIA to install the update…' });
            try {
              updater.quitAndInstall(true, true);
            } catch {
              send({ state: 'error', message: 'Could not start the update installer. Try again.' });
            }
          }
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
