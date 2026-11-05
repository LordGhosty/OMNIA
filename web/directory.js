(() => {
  const root = document.querySelector('#tool-categories');
  const categories = new Map();
  const windows = document.createElement('section');
  windows.className = 'platform-group';
  const platformHeading = document.createElement('h2');
  platformHeading.className = 'platform-heading';
  platformHeading.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="10.5" height="10.5" fill="#bcbcbc"/><rect x="12.5" y="1" width="10.5" height="10.5" fill="#d2d2d2"/><rect x="1" y="12.5" width="10.5" height="10.5" fill="#949494"/><rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#b0b0b0"/></svg>';
  platformHeading.append(document.createTextNode('Windows'));
  windows.append(platformHeading);
  const span = (className, text) => {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  };
  for (const [index, tool] of window.omniaTools.entries()) {
    const categoryKey = (tool.platform || 'all') + ':' + tool.category;
    if (!categories.has(categoryKey)) {
      const section = document.createElement('section'),
        heading = document.createElement(tool.platform === 'win32' ? 'h3' : 'h2'),
        list = document.createElement('div');
      heading.className = 'category-heading';
      heading.append(document.createTextNode(tool.category), span('category-count', ''));
      list.className = 'tool-directory';
      list.dataset.layout = 'grid';
      section.append(heading, list);
      (tool.platform === 'win32' ? windows : root).append(section);
      categories.set(categoryKey, { section, list, heading });
    }
    const button = document.createElement('button');
    button.className = 'tool-card';
    button.dataset.tool = tool.id;
    button.hidden = !!tool.condition;
    if (tool.condition) button.dataset.condition = tool.condition;
    if (tool.id === 'mp3') button.id = 'open-converter';
    const icon = span('tool-icon', '❯');
    icon.setAttribute('aria-hidden', 'true');
    const copy = span('tool-copy', '');
    copy.append(
      span('tool-title', tool.name),
      span('tool-description', tool.description),
      span('tool-tags', tool.tags),
    );
    const mark = span('tool-insignia', '');
    mark.dataset.insignia = tool.insignia;
    mark.setAttribute('aria-hidden', 'true');
    const launch = span('tool-launch', '');
    launch.append(span('', 'OPEN TOOL'), span('arrow', '→'));
    button.append(
      span('tool-number', String(index + 1).padStart(2, '0')),
      icon,
      copy,
      mark,
      launch,
    );
    categories.get(categoryKey).list.append(button);
  }
  root.append(windows);
  window.refreshDirectory = () => {
    let total = 0;
    for (const { section, list, heading } of categories.values()) {
      const count = [...list.children].filter((el) => !el.hidden && !el.disabled).length;
      total += count;
      section.hidden = ![...list.children].some((el) => !el.hidden);
      heading.querySelector('.category-count').textContent =
        String(count).padStart(2, '0') + (count === 1 ? ' TOOL' : ' TOOLS');
    }
    document.querySelector('#available-count').textContent =
      String(total).padStart(2, '0') + ' AVAILABLE';
    windows.hidden = ![...windows.querySelectorAll('.tool-card')].some((card) => !card.hidden);
  };
  window.refreshDirectory();
})();
