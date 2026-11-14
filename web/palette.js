(() => {
  const chart = document.querySelector('#palette-chart');
  const tower = document.querySelector('#palette-tower');
  function svg(tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  function edge(share) {
    const angle = share * 2 * Math.PI;
    return [50 + 49 * Math.sin(angle), 50 - 49 * Math.cos(angle)].join(' ');
  }
  window.renderPalette = (colours) => {
    document.querySelector('#palette-count').textContent = String(colours.length).padStart(2, '0');
    const mask = svg('mask', {
      id: 'palette-reveal',
      maskUnits: 'userSpaceOnUse',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    mask.append(
      svg('circle', {
        cx: 50,
        cy: 50,
        r: 25,
        fill: 'none',
        stroke: 'white',
        'stroke-width': 51,
        transform: 'rotate(-90 50 50)',
        pathLength: 100,
        class: 'palette-sweep',
      }),
    );
    const slices = svg('g', { mask: 'url(#palette-reveal)' });
    chart.replaceChildren(mask, slices);
    tower.replaceChildren();
    let start = 0;
    for (const { hex, share } of colours) {
      const end = start + share;
      slices.append(
        colours.length === 1
          ? svg('circle', { cx: 50, cy: 50, r: 49, fill: hex })
          : svg('path', {
              fill: hex,
              d: `M50 50 L${edge(start)} A49 49 0 ${share > 0.5 ? 1 : 0} 1 ${edge(end)} Z`,
            }),
      );
      const row = document.createElement('button');
      row.type = 'button';
      row.title = 'Copy ' + hex;
      const swatch = document.createElement('span');
      swatch.className = 'palette-swatch';
      swatch.style.backgroundColor = hex;
      const code = document.createElement('span');
      code.textContent = hex;
      const amount = document.createElement('span');
      amount.textContent = (share * 100).toFixed(1) + '%';
      row.setAttribute('aria-label', `Copy ${hex}, ${amount.textContent}`);
      row.style.setProperty('--delay', Math.round(start * 650) + 'ms');
      row.append(swatch, code, amount);
      row.addEventListener('click', async () => {
        const message = document.querySelector('#output-summary');
        try {
          message.textContent = (await window.omnia.copyText(hex))
            ? 'Copied ' + hex
            : 'Could not copy the colour.';
        } catch {
          message.textContent = 'Could not copy the colour.';
        }
      });
      tower.append(row);
      start = end;
    }
  };
})();
