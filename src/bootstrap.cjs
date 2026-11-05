const { app, dialog, shell } = require('electron');
const path = require('node:path');
let recovery;
async function start() {
  if (process.env.OMNIA_SMOKE === '1')
    app.setPath('userData', path.join(process.cwd(), '.qa', 'smoke-profile'));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.omniaLock = true;
  const config = require('../assets/updates.json'),
    trust = require('../assets/release-trust.json');
  recovery = require('./recovery.cjs').createRecovery({
    directory: path.join(app.getPath('userData'), 'recovery'),
    version: app.getVersion(),
    buildId: require('../assets/build-id.json').id,
    repository: config.repository,
    verify: (file) => require('./validation.cjs').checkWindowsSignature(file, trust),
  });
  const state = await recovery.begin();
  if (state.attempts >= 3) {
    await app.whenReady();
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'OMNIA recovery',
      message: 'OMNIA could not finish starting.',
      detail:
        'Start with all tools quarantined, open the recovery utility, or exit. Your files will not be changed.',
      buttons: ['Start without tools', 'Open recovery', 'Exit'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) {
      app.quit();
      return;
    }
    if (choice.response === 1) {
      await shell.openPath(path.join(path.dirname(process.execPath), 'OMNIA Recovery.exe'));
      app.quit();
      return;
    }
    await require('./recovery.cjs').writeJSON(
      path.join(app.getPath('userData'), 'tool-quarantine.json'),
      {
        buildId: require('../assets/build-id.json').id,
        faults: require('../assets/tools.json').map((tool) => ({
          id: tool.id,
          reason: 'Disabled by recovery mode.',
          at: new Date().toISOString(),
        })),
      },
    );
  }
  require('./main.cjs');
}
module.exports = { healthy: () => recovery?.healthy(), get: () => recovery };
start().catch(async () => {
  await app.whenReady();
  dialog.showErrorBox(
    'OMNIA could not start',
    'Use OMNIA Recovery from the installation folder or reinstall an official release.',
  );
  app.quit();
});
