const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const capture = require('./smoke-capture.cjs');
const { dialog, clipboard } = require('electron');

/** Exercises native dialogs and renderer IPC using disposable key files. */
module.exports = async function sshSmoke({ window, contents, dir, report }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnia-key-ui-'));
  const originalOpen = dialog.showOpenDialog;
  const originalSave = dialog.showSaveDialog;
  const originalCopy = clipboard.writeText;
  let chosen = root,
    copied;
  const evaluate = (code) =>
    (contents || window.webContents).executeJavaScript(
      `(async()=>{const w=window,d=document;${code}})()`,
    );
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(predicate)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(
      'SSH interface timed out: ' +
        (await evaluate('return d.querySelector("#system-status").textContent')),
    );
  };
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: path.join(root, 'export.pub'),
    });
    clipboard.writeText = (value) => {
      copied = value;
    };
    await evaluate('d.querySelector("#ssh-folder").click()');
    await wait('return (await w.omnia.ssh("status")).destination!==null');
    await evaluate(
      'd.querySelector("#ssh-passphrase").value="fixture-passphrase";d.querySelector("#ssh-confirm").value="fixture-passphrase";d.querySelector("#ssh-rounds").value=16;d.querySelector("#ssh-run").click()',
    );
    await wait(
      'return !d.querySelector("#ssh-run").disabled && !d.querySelector("#ssh-result").hidden',
    );
    const state = await evaluate('return w.omnia.ssh("status")');
    if (!state.result.encrypted || !state.result.privatePath.startsWith(root + path.sep))
      throw Error('SSH key output mismatch.');
    if (
      await evaluate(
        'return !!d.querySelector("#ssh-passphrase").value || !!d.querySelector("#ssh-confirm").value',
      )
    )
      throw Error('SSH input retained a passphrase.');
    await evaluate('d.querySelector("#ssh-copy-public").click()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (copied !== state.result.line) throw Error('Public-key clipboard mismatch.');
    await evaluate('d.querySelector("#ssh-export").click()');
    await wait('return d.querySelector("#system-status").textContent==="Public key saved."');
    if ((await fs.readFile(path.join(root, 'export.pub'), 'utf8')).trim() !== state.result.line)
      throw Error('Public-key export mismatch.');
    chosen = state.result.privatePath;
    await evaluate(
      'd.querySelector("[data-mode=inspect]").click();d.querySelector("#ssh-drop").click()',
    );
    await wait('return d.querySelector("#ssh-result").hidden');
    await evaluate(
      'd.querySelector("#ssh-old-passphrase").value="fixture-passphrase";d.querySelector("#ssh-run").click()',
    );
    await wait(
      'return !d.querySelector("#ssh-run").disabled && !d.querySelector("#ssh-result").hidden',
    );
    if (
      (await evaluate('return w.omnia.ssh("status")')).result.fingerprint !==
      state.result.fingerprint
    )
      throw Error('Inspected fingerprint mismatch.');
    await fs.writeFile(
      path.join(dir, 'ssh-key-forge.png'),
      await capture(contents || window.webContents),
    );
    await evaluate('d.querySelector("#ssh-clear").click()');
    await wait('return d.querySelector("#ssh-result").hidden');
    await fs.access(chosen);
    report.ssh = {
      encrypted: true,
      publicCopy: true,
      publicExport: true,
      inspect: true,
      clearPreservesFiles: true,
    };
  } finally {
    dialog.showOpenDialog = originalOpen;
    dialog.showSaveDialog = originalSave;
    clipboard.writeText = originalCopy;
    await fs.rm(root, { recursive: true, force: true });
  }
};
