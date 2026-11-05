module.exports = async (event) => {
  if (process.env.OMNIA_OFFICIAL_RELEASE !== '1' || event.targetPresentableName !== 'AppImage')
    return;
  const context = require('./after-pack.cjs').contexts.get(event.arch);
  if (!context) throw Error('The signed AppImage package context is missing.');
  // Finalized executable inventory.
  await require('./sign-release.cjs').hook(context);
};
