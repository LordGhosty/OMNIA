window.systemUI = (() => {
  const $ = (s) => document.querySelector(s),
    el = (tag, text, className) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (className) n.className = className;
      return n;
    };
  const bytes = (n) => {
    if (n == null) return 'Not reported';
    if (n === 0) return '0 B';
    const i = Math.min(4, Math.floor(Math.log(Math.abs(n)) / Math.log(1024)));
    return (
      (n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 }) +
      ' ' +
      ['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]
    );
  };
  const message = (text) => ($('#system-status').textContent = text);
  const safe =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        message(e.message);
      }
    };
  const button = (text, fn) => {
    const b = el('button', text, 'system-button');
    b.addEventListener('click', safe(fn));
    return b;
  };
  function details(root, entries) {
    root.replaceChildren();
    for (const [key, value] of entries) {
      root.append(
        el('dt', key),
        el('dd', Array.isArray(value) ? value.join(', ') : String(value ?? 'Not reported')),
      );
    }
  }
  function download(name, value) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    );
    const link = el('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return { $, el, bytes, message, safe, button, details, download };
})();
