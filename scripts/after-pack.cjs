module.exports = async (context) => {
  if (process.env.OMNIA_OFFICIAL_RELEASE !== '1') return;
  require('./release-key.cjs').loadKey();
  if (context.electronPlatformName === 'linux') contexts.set(context.arch, context);
};
const contexts = new Map();
module.exports.contexts = contexts;
