/** Group an sRGB thumbnail into up to six colours, weighted by visible pixel area. */
function dominantColours(rgba) {
  const bins = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (!alpha) continue;
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    const bin = bins.get(key) || { weight: 0, rgb: [0, 0, 0] };
    bin.weight += alpha;
    for (let c = 0; c < 3; c++) bin.rgb[c] += rgba[i + c] * alpha;
    bins.set(key, bin);
  }
  if (!bins.size)
    throw Error('This image is fully transparent. Choose an image with visible colours.');
  const points = [...bins.values()].sort((a, b) => b.weight - a.weight);
  for (const point of points) point.rgb = point.rgb.map((value) => value / point.weight);
  const centres = [points[0].rgb];
  const distance = (a, b) =>
    2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2;
  const residuals = points.map(() => Infinity);
  while (centres.length < Math.min(6, points.length)) {
    let best = 0,
      highest = 0;
    for (const [i, point] of points.entries()) {
      residuals[i] = Math.min(residuals[i], distance(point.rgb, centres.at(-1)));
      const score = residuals[i] * point.weight;
      if (score > highest) {
        highest = score;
        best = i;
      }
    }
    centres.push(points[best].rgb);
  }
  let groups;
  const labels = new Int8Array(points.length).fill(-1);
  for (let pass = 0; pass < 12; pass++) {
    groups = centres.map(() => ({ weight: 0, rgb: [0, 0, 0] }));
    let changed = false;
    for (const [i, point] of points.entries()) {
      let nearest = 0,
        min = Infinity;
      for (const [j, centre] of centres.entries()) {
        const delta = distance(point.rgb, centre);
        if (delta < min) {
          min = delta;
          nearest = j;
        }
      }
      if (labels[i] !== nearest) changed = true;
      labels[i] = nearest;
      const group = groups[nearest];
      group.weight += point.weight;
      for (let c = 0; c < 3; c++) group.rgb[c] += point.rgb[c] * point.weight;
    }
    for (const [j, group] of groups.entries())
      if (group.weight) centres[j] = group.rgb.map((value) => value / group.weight);
    if (!changed) break;
  }
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  return centres
    .map((rgb, i) => ({
      hex: '#' + Buffer.from(rgb.map(Math.round)).toString('hex').toUpperCase(),
      share: groups[i].weight / total,
    }))
    .filter((colour) => colour.share > 0)
    .sort((a, b) => b.share - a.share);
}
module.exports = { dominantColours };
