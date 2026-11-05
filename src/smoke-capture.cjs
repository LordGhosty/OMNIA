const { nativeImage } = require('electron');

/** Captures embedded views when Chromium cannot copy their compositor surface. */
module.exports = async function capture(contents) {
  try {
    const image = await contents.capturePage();
    if (image.isEmpty()) throw Error('Empty screenshot.');
    return image.toPNG();
  } catch (error) {
    if (error.message !== 'UnknownVizError') throw error;
    const attached = contents.debugger.isAttached();
    try {
      if (!attached) contents.debugger.attach('1.3');
      const result = await contents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: false,
      });
      const bytes = Buffer.from(result.data, 'base64');
      if (nativeImage.createFromBuffer(bytes).isEmpty()) throw Error('Empty fallback screenshot.');
      return bytes;
    } catch (captureError) {
      throw Error(
        `Screenshot failed for ${new URL(contents.getURL()).pathname}: ${captureError.message}`,
      );
    } finally {
      if (!attached && contents.debugger.isAttached()) contents.debugger.detach();
    }
  }
};
