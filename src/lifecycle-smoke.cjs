const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, window, views }) => {
  const mode = process.env.OMNIA_LIFECYCLE_SMOKE;
  if (!['home', 'cached', 'active', 'transition', 'loading', 'destroyed'].includes(mode))
    throw Error('Unknown lifecycle check.');
  const report = { mode, pid: process.pid, packaged: app.isPackaged, phases: [] };
  const file = path.join(process.cwd(), '.qa', 'lifecycle-' + mode + '.json');
  const record = (phase) => {
    report.phases.push(phase);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  };
  process.on('uncaughtExceptionMonitor', (error) => {
    report.error = error.stack;
    record('uncaught');
  });
  window.once('closed', () => {
    record('closed');
    app.emit('second-instance', {}, [], process.cwd());
    record('late-second-instance');
  });
  app.once('will-quit', () => record('will-quit'));
  if (['cached', 'active', 'transition', 'destroyed'].includes(mode)) await views.open('mp3');
  if (['cached', 'transition'].includes(mode)) await views.open('home');
  record('ready');
  let opening;
  if (['loading', 'transition'].includes(mode)) {
    opening = views.open('mp3');
    if (mode === 'transition') await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (mode === 'destroyed') window.destroy();
  else window.close();
  if (opening && (await opening)) throw Error('A closing tool finished navigation.');
};
