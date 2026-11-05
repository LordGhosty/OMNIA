module.exports = async (context) => {
  if (context.electronPlatformName === 'win32') await require('./sign-release.cjs').hook(context);
};
