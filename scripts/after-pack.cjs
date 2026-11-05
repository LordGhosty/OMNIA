module.exports = async (context) => {
  if (process.env.OMNIA_OFFICIAL_RELEASE !== '1') return;
  if (!process.env.OMNIA_RELEASE_PRIVATE_KEY)
    throw Error('Official release signing is not configured.');
  if (context.electronPlatformName === 'linux') contexts.set(context.arch, context);
};
const contexts = new Map();
module.exports.contexts = contexts;
