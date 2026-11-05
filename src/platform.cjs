const os = require('node:os');
function windowsTarget(release = os.release(), arch = process.arch, platform = process.platform) {
  const [major, minor, build] = String(release).split('.').map(Number);
  return {
    platform,
    arch,
    release,
    build: Number.isInteger(build) ? build : null,
    target: platform === 'win32' && arch === 'x64' && major === 10 && minor === 0 && build >= 19045,
    family:
      platform !== 'win32'
        ? platform
        : major === 10 && build >= 22000
          ? 'Windows 11 or Windows Server'
          : major === 10
            ? 'Windows 10 or Windows Server'
            : 'Earlier Windows',
  };
}
module.exports = { windowsTarget };
