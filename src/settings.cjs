const fs = require('node:fs/promises');
const path = require('node:path');
const defaults = Object.freeze({
  enabled: true,
  insignia: true,
  transitions: true,
  details: true,
  windowResize: true,
});

/** Stores window and animation preferences independently of tool sessions. */
async function createSettings(file, onChange = () => {}) {
  let state = { ...defaults },
    queue = Promise.resolve();
  try {
    if ((await fs.stat(file)).size <= 4096) {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const key of Object.keys(defaults))
        if (typeof saved?.[key] === 'boolean') state[key] = saved[key];
    }
  } catch {
    // Missing or invalid preferences use the defaults.
  }
  const get = () => ({ ...state });
  function update(patch) {
    if (
      !patch ||
      Array.isArray(patch) ||
      typeof patch !== 'object' ||
      !Object.keys(patch).length ||
      Object.entries(patch).some(
        ([key, value]) => !Object.hasOwn(defaults, key) || typeof value !== 'boolean',
      )
    )
      return Promise.reject(Error('Unsupported setting.'));
    patch = { ...patch };
    const task = queue.then(async () => {
      const next = { ...state, ...patch };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
      state = next;
      onChange(get());
      return get();
    });
    queue = task.catch(() => {});
    return task;
  }
  return { get, update };
}
module.exports = { createSettings, defaults };
