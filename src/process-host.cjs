const path = require('node:path');

/** Supervises a lazy tool process. Heartbeats remain independent of operation duration. */
function createProcessService({
  kind,
  options = {},
  fork,
  guard,
  broker,
  onEvent = () => {},
  onFault = () => {},
  onActivity = () => {},
  heartbeatMs = 12000,
  startMs = 15000,
  callMs = 30 * 60 * 1000,
}) {
  let child,
    containment,
    starting,
    failed = false,
    closing = false,
    lastBeat = 0,
    busy = false,
    sequence = 0;
  const pending = new Map();
  const passiveCalls = new Set([
    'status',
    'view',
    'asset',
    'source',
    'query',
    'quick',
    'location',
    'history',
    'connection',
  ]);
  let reportedActivity = false;
  function reportActivity() {
    const active =
      !failed &&
      !closing &&
      (busy || [...pending.values()].some((p) => !passiveCalls.has(p.method)));
    if (active === reportedActivity) return;
    reportedActivity = active;
    onActivity(active);
  }
  const fault = (reason) => {
    if (failed || closing) return;
    failed = true;
    busy = false;
    const error = Object.assign(Error(reason), { code: 'OMNIA_TOOL_FAILED' });
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    pending.clear();
    reportActivity();
    child?.kill();
    containment?.close();
    containment = null;
    child = null;
    try {
      onFault(reason);
    } catch {}
  };
  const timer = setInterval(() => {
    if (child && lastBeat && Date.now() - lastBeat > heartbeatMs)
      fault('The tool stopped responding.');
  }, 1000);
  timer.unref();
  async function start() {
    if (failed)
      throw Object.assign(Error('This tool is quarantined. Reset it from the directory.'), {
        code: 'OMNIA_TOOL_FAILED',
      });
    if (starting) return starting;
    if (child) return;
    closing = false;
    starting = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        fault('The tool could not start.');
        reject(Error('Tool startup timed out.'));
      }, startMs);
      const finish = (error) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      try {
        child = fork(path.join(__dirname, 'tool-process.cjs'), [], {
          serviceName: 'OMNIA ' + kind,
          stdio: 'pipe',
        });
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', () => {});
        child.on('exit', () => {
          if (!closing) {
            fault('The tool process stopped.');
            finish(Error('The tool process stopped.'));
          }
        });
        child.on('error', () => {
          fault('The tool process could not start.');
          finish(Error('The tool process could not start.'));
        });
        child.on('message', async (packet) => {
          try {
            if (!packet || typeof packet !== 'object') return;
            if (packet.type === 'ready') {
              lastBeat = Date.now();
              finish();
            } else if (packet.type === 'beat') {
              lastBeat = Date.now();
              busy = !!packet.busy;
              reportActivity();
            } else if (packet.type === 'fault') {
              fault(packet.reason || 'The tool stopped unexpectedly.');
              finish(Error('Tool initialization failed.'));
            } else if (packet.type === 'event') {
              try {
                onEvent(packet.name, packet.data);
              } catch {
                fault('The tool sent an invalid event.');
              }
            } else if (packet.type === 'reply') {
              const item = pending.get(packet.id);
              if (!item) return;
              pending.delete(packet.id);
              clearTimeout(item.timeout);
              busy = !!packet.busy;
              reportActivity();
              packet.error
                ? item.reject(
                    Object.assign(Error(packet.error.message), { code: packet.error.code }),
                  )
                : item.resolve(packet.value);
            } else if (packet.type === 'broker') {
              const owner = child;
              try {
                const value = await broker(packet.action, packet.data, (text) =>
                  owner?.postMessage({ type: 'broker-progress', id: packet.id, text }),
                );
                if (owner === child)
                  owner.postMessage({ type: 'broker-reply', id: packet.id, value });
              } catch (error) {
                if (owner === child)
                  owner?.postMessage({
                    type: 'broker-reply',
                    id: packet.id,
                    error: { message: error.message },
                  });
              }
            }
          } catch {
            fault('The tool connection failed.');
          }
        });
        const owner = child;
        const initialize = async () => {
          try {
            if (guard) {
              const protection = await guard(owner.pid, () =>
                fault('The tool process guard stopped.'),
              );
              if (failed || closing || owner !== child) {
                protection.close();
                return;
              }
              containment = protection;
            }
            owner.postMessage({ type: 'init', kind, options });
          } catch (error) {
            fault('The tool could not start safely.');
            finish(error);
          }
        };
        if (owner.pid) void initialize();
        else owner.once('spawn', () => void initialize());
      } catch (error) {
        fault('The tool process could not start.');
        finish(error);
      }
    }).finally(() => {
      starting = null;
    });
    return starting;
  }
  async function call(method, args) {
    await start();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => fault('The tool operation timed out.'), callMs);
      timeout.unref();
      pending.set(id, { resolve, reject, method, timeout });
      reportActivity();
      try {
        child.postMessage({ type: 'call', id, method, args });
      } catch {
        fault('The tool connection closed.');
      }
    });
  }
  async function close() {
    closing = true;
    reportActivity();
    clearInterval(timer);
    if (child) {
      const current = child;
      let timeout;
      try {
        await Promise.race([
          new Promise((resolve) => {
            current.once('exit', resolve);
            current.postMessage({ type: 'shutdown' });
          }),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, 2500);
          }),
        ]);
      } catch {
      } finally {
        clearTimeout(timeout);
      }
      current.kill();
      child = null;
    }
    containment?.close();
    containment = null;
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(Error('The tool was closed.'));
    }
    pending.clear();
    busy = false;
  }
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (name === 'then') return undefined;
        if (name === 'isBusy' || name === 'isMutating')
          return () =>
            busy ||
            [...pending.values()].some(
              (p) =>
                ![
                  'status',
                  'view',
                  'asset',
                  'source',
                  'query',
                  'quick',
                  'info',
                  'location',
                  'history',
                ].includes(p.method),
            );
        if (name === 'close') return close;
        if (name === 'updateAdmin')
          return (state) => {
            options.adminState = state;
            child?.postMessage({ type: 'admin', state });
          };
        if (name === 'pid') return child?.pid;
        return (...args) => call(name, args);
      },
    },
  );
}
module.exports = { createProcessService };
