(() => {
  if (!window.omnia?.toolHealth) return;
  const panel = document.createElement('section');
  panel.className = 'tool-health';
  panel.hidden = true;
  const heading = document.createElement('h2');
  heading.className = 'category-heading';
  heading.textContent = 'Unavailable tools';
  const list = document.createElement('div');
  panel.append(heading, list);
  document.querySelector('.tool-menu').append(panel);
  let previous = new Set();
  function render(faults) {
    const failed = new Set(faults.map((f) => f.id));
    for (const id of previous)
      if (!failed.has(id)) {
        try {
          void Promise.resolve(window.omniaRouter.discard(id)).catch(() => {});
        } catch {}
      }
    previous = failed;
    for (const card of document.querySelectorAll('.tool-card')) {
      card.disabled = failed.has(card.dataset.tool);
      card.classList.toggle('tool-unavailable', card.disabled);
    }
    panel.hidden = !faults.length;
    list.replaceChildren();
    for (const fault of faults) {
      const row = document.createElement('div'),
        text = document.createElement('p'),
        button = document.createElement('button');
      text.textContent =
        (window.omniaTools.find((t) => t.id === fault.id)?.name || fault.id) + ' · ' + fault.reason;
      button.textContent = 'Reset tool';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await window.omniaRouter.discard(fault.id);
          render(await window.omnia.toolHealth('reset', { id: fault.id }));
        } catch (error) {
          text.textContent = error.message;
          button.disabled = false;
        }
      });
      row.append(text, button);
      list.append(row);
    }
    window.refreshDirectory();
  }
  window.omnia.onToolHealth(render);
  window.omnia
    .toolHealth('status')
    .then(render)
    .catch(() => {});
})();
