const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dominantColours } = require('../src/palette.cjs');
test('palette shares count alpha coverage and preserve solid colours', () => {
  const colours = dominantColours(
    Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 128, 0, 255, 0, 0]),
  );
  assert.deepEqual(colours, [
    { hex: '#FF0000', share: 510 / 638 },
    { hex: '#0000FF', share: 128 / 638 },
  ]);
  assert.deepEqual(dominantColours(Buffer.from([18, 52, 86, 255])), [{ hex: '#123456', share: 1 }]);
  assert.throws(() => dominantColours(Buffer.alloc(4)), /transparent/);
});
test('a varied image yields six ranked groups covering the full sample', () => {
  const pixels = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) pixels.set([i, (i * 17) % 256, 255 - i, 255], i * 4);
  const colours = dominantColours(pixels);
  assert.equal(colours.length, 6);
  assert.equal(new Set(colours.map((c) => c.hex)).size, 6);
  assert.equal(
    colours.reduce((sum, c) => sum + c.share, 0),
    1,
  );
  assert.deepEqual(
    colours.map((c) => c.share),
    colours.map((c) => c.share).sort((a, b) => b - a),
  );
});
