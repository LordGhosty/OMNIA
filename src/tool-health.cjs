/** Supervises tool services without replacing or interrupting active mutations. */
function createToolHost(onChange = () => {}, { statePath, buildId = 'development' } = {}) {
  const fs = require('node:fs'),
    path = require('node:path');
  const services = new Map(),
    faults = new Map();
  if (statePath)
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (saved.buildId === buildId)
        for (const fault of saved.faults || [])
          if (typeof fault.id === 'string') faults.set(fault.id, fault);
    } catch {}
  function save() {
    if (statePath)
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const temp = statePath + '.tmp';
        fs.writeFileSync(temp, JSON.stringify({ buildId, faults: status() }));
        fs.renameSync(temp, statePath);
      } catch {}
  }
  const status = () => [...faults.values()];

  function quarantine(ids, reason = 'The tool stopped unexpectedly.') {
    for (const id of ids) faults.set(id, { id, reason, at: new Date().toISOString() });
    save();
    onChange(status());
  }
  function fail(ids, reason) {
    for (const id of ids) {
      const entry = services.get(id);
      if (entry) entry.disabled = true;
    }
    quarantine(ids, reason);
  }

  async function register(ids, factory) {
    const entry = { ids, factory, target: null, loading: false, disabled: false };
    for (const id of ids) services.set(id, entry);
    if (ids.some((id) => faults.has(id))) entry.disabled = true;
    else await load(entry);
    return new Proxy(
      {},
      {
        get(_object, name) {
          if (name === 'then') return undefined;
          if (name === 'isBusy')
            return () =>
              entry.loading || !!entry.target?.isBusy?.() || !!entry.target?.isMutating?.();
          if (name === 'isMutating') return () => !!entry.target?.isMutating?.();
          if (name === 'close') return () => entry.target?.close?.();
          if (name === 'stop' || name === 'cancel')
            return (...args) => entry.target?.[name]?.(...args);
          if (entry.target && !entry.disabled && typeof entry.target[name] !== 'function')
            return entry.target[name];
          return (...args) => {
            if (!entry.target || entry.disabled)
              throw Error('This tool is unavailable. Reset it from the directory.');
            try {
              const value = entry.target[name](...args);
              return value?.then
                ? value.catch((error) => {
                    record(entry, error);
                    throw error;
                  })
                : value;
            } catch (error) {
              record(entry, error);
              throw error;
            }
          };
        },
      },
    );
  }

  function record(entry, error) {
    if (
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error.code === 'OMNIA_TOOL_FAILED'
    ) {
      entry.disabled = true;
      quarantine(entry.ids);
    }
  }

  async function load(entry) {
    entry.loading = true;
    try {
      entry.target = await entry.factory();
      entry.disabled = false;
      for (const id of entry.ids) faults.delete(id);
      save();
    } catch {
      entry.target = null;
      entry.disabled = true;
      quarantine(entry.ids, 'The tool could not start.');
    } finally {
      entry.loading = false;
      onChange(status());
    }
  }

  /** Recreates only the affected service after its work has stopped. */
  async function reset(id) {
    const entry = services.get(id);
    if (!entry) {
      faults.delete(id);
      save();
      onChange(status());
      return status();
    }
    if (entry.loading || entry.target?.isBusy?.() || entry.target?.isMutating?.())
      throw Error('Wait for the operation to finish before resetting this tool.');
    if (!entry.disabled) {
      faults.delete(id);
      save();
      onChange(status());
      return status();
    }
    try {
      await entry.target?.close?.();
    } catch {
      throw Error('The tool could not stop cleanly. Restart OMNIA after its operation finishes.');
    }
    await load(entry);
    return status();
  }

  return {
    register,
    quarantine,
    fail,
    reset,
    status,
    has: (id) => faults.has(id),
    blocked: (id) => !!services.get(id)?.disabled,
  };
}
module.exports = { createToolHost };
