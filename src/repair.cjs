const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const tasks = [
  {
    id: 'dism-check',
    name: 'Component store status',
    description: 'Check whether Windows has already recorded component-store corruption.',
    command: 'DISM /Online /Cleanup-Image /CheckHealth /English /NoRestart',
    changes: false,
  },
  {
    id: 'dism-scan',
    name: 'Scan component store',
    description: 'Run a deeper scan for corruption. This can take several minutes.',
    command: 'DISM /Online /Cleanup-Image /ScanHealth /English /NoRestart',
    changes: false,
  },
  {
    id: 'sfc-check',
    name: 'Verify system files',
    description: 'Check protected Windows files without replacing them.',
    command: 'sfc /verifyonly',
    changes: false,
  },
  {
    id: 'disk-check',
    name: 'Check a volume',
    description:
      'Read-only CHKDSK. Active files can affect results; this does not schedule repairs or a restart.',
    command: 'chkdsk <selected volume>',
    changes: false,
  },
  {
    id: 'dism-repair',
    name: 'Repair component store',
    description: 'Repair Windows components. Windows Update may be used to download repair files.',
    command: 'DISM /Online /Cleanup-Image /RestoreHealth /English /NoRestart',
    changes: true,
  },
  {
    id: 'sfc-repair',
    name: 'Repair system files',
    description: 'Scan protected Windows files and replace damaged versions when possible.',
    command: 'sfc /scannow',
    changes: true,
  },
  {
    id: 'repair-sequence',
    name: 'DISM + SFC repair',
    description: 'Repair the component store, then run SFC if DISM completes with exit code 0.',
    command: 'DISM /Online /Cleanup-Image /RestoreHealth /English /NoRestart\nsfc /scannow',
    changes: true,
  },
];
/** Runs fixed Windows repair tasks through the admin service and persists their results. */
function createRepair({ admin, inventoryFn, reportPath, platform = process.platform } = {}) {
  let job = null;
  const plans = new Map();
  const busy = () => job?.state === 'running';
  const status = () => ({ supported: platform === 'win32', tasks, job });
  async function prepare(id, volumeId) {
    if (platform !== 'win32') throw Error('Windows Repair is available on Windows.');
    if (busy()) throw Error('Wait for the current Windows operation.');
    if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
    const task = tasks.find((t) => t.id === id);
    if (!task) throw Error('Unsupported repair operation.');
    let volume;
    if (id === 'disk-check') {
      volume = (await inventoryFn()).volumes.find(
        (v) => v.id === volumeId && /^[A-Z]:\\$/.test(v.root) && v.size > 0,
      );
      if (!volume) throw Error('Select an available volume.');
    }
    const token = crypto.randomUUID(),
      payload = {
        task: id,
        ...(volume ? { volume: volume.root.slice(0, 2), volumeId: volume.id } : {}),
      };
    plans.clear();
    plans.set(token, { task, payload, expires: Date.now() + 120000 });
    return { token, ...task, command: volume ? 'chkdsk ' + volume.root.slice(0, 2) : task.command };
  }
  async function execute(token) {
    if (busy()) throw Error('A repair is already running.');
    const plan = plans.get(token);
    plans.delete(token);
    if (!plan || plan.expires < Date.now())
      throw Error('Review expired. Choose the operation again.');
    if (!admin.status().enabled) throw Error('Enable the administrator shield first.');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    job = {
      id: crypto.randomUUID(),
      name: plan.task.name,
      command:
        plan.payload.task === 'disk-check' ? 'chkdsk ' + plan.payload.volume : plan.task.command,
      state: 'running',
      started: new Date().toISOString(),
      output: '',
      changes: plan.task.changes,
    };
    void admin
      .run('repair-run', plan.payload, (text) => {
        job.output = (job.output + text).slice(-220000);
      })
      .then((reply) => {
        job.result = JSON.parse(reply.message);
        job.state = job.result.steps.every((s) => s.exitCode === 0) ? 'finished' : 'attention';
      })
      .catch((error) => {
        job.state = 'error';
        job.error = error.message;
      })
      .finally(async () => {
        job.finished = new Date().toISOString();
        try {
          await fs.writeFile(reportPath, JSON.stringify(job, null, 2));
        } catch (e) {
          job.saveError = e.message;
        }
      });
    return status();
  }
  return { status, prepare, execute, isBusy: busy };
}
module.exports = { createRepair, tasks };
