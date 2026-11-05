const fs = require('node:fs/promises'),
  path = require('node:path');
const capture = require('./smoke-capture.cjs');
module.exports = async ({ tool, contents, dir, report }) => {
  const js = (code) => contents.executeJavaScript(`(()=>{const w=window,d=document;${code}})()`),
    delay = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(code) {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await delay(50);
    }
    throw Error(
      tool +
        ' file test timed out: ' +
        (await js(
          "return d.querySelector('#system-status').textContent+' '+d.querySelector('#file-review-error').textContent;",
        )),
    );
  }
  const fixture = await fs.mkdtemp(path.join(dir, 'file-ui-'));
  await fs.writeFile(path.join(fixture, 'document.txt'), 'Shared file contents');
  await fs.writeFile(path.join(fixture, 'document-copy.txt'), 'Shared file contents');
  await fs.writeFile(path.join(fixture, 'image.txt'), 'Different contents');
  await fs.mkdir(path.join(fixture, 'nested'));
  const { dialog } = require('electron'),
    original = dialog.showOpenDialog;
  report.fileTools ??= {};
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    await js("d.querySelector('#clear-files').click();");
    await until("return d.querySelector('#system-status').textContent==='Files cleared.';");
    await until("return d.querySelectorAll('#location-tree input').length>0;");
    const folders = await js(
      "return w.omnia.fileTools('roots',{tool:d.body.dataset.tool,part:'folders'});",
    );
    if (!folders.folders.some((entry) => entry.path === require('electron').app.getPath('desktop')))
      throw Error('Desktop location was not discovered from Windows.');
    if (tool === 'rename') await js("d.querySelector('#choose-folders').click();");
    else
      await js(
        `d.querySelector('#location-path').value=${JSON.stringify(fixture)};d.querySelector('#location-address').requestSubmit();`,
      );
    await until("return d.querySelector('#file-scopes').children.length===1;");
    if (tool === 'search') await js("d.querySelector('#filter-name').value='document*.txt';");
    await js("d.querySelector('#scan-files').click();");
    await until("return d.querySelector('#system-status').textContent.startsWith('Complete');");
    if (tool === 'rename') {
      await js(
        "d.querySelector('#rename-prefix').value='sorted-';d.querySelector('#rename-preview').click();",
      );
      await until("return d.querySelector('#file-review').open;");
      await fs.writeFile(path.join(dir, 'batch-rename-review.png'), await capture(contents));
      await js("d.querySelector('#review-apply').click();");
      await until(
        "return !d.querySelector('#file-review').open&&d.querySelector('#system-status').textContent==='Renamed 3 files.';",
      );
      if (
        !(await fs.readdir(fixture, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .every((entry) => entry.name.startsWith('sorted-'))
      )
        throw Error('Rename UI did not apply names.');
      if (!(await fs.stat(path.join(fixture, 'nested'))).isDirectory())
        throw Error('Rename changed a folder.');
      await js("d.querySelector('#rename-history button').click();");
      await until("return d.querySelector('#file-review').open;");
      await js("d.querySelector('#review-apply').click();");
      await until(
        "return !d.querySelector('#file-review').open&&d.querySelector('#system-status').textContent==='Renamed 3 files.';",
      );
      if (!(await fs.readdir(fixture)).includes('document.txt'))
        throw Error('Rename UI undo failed.');
      report.fileTools.rename = { apply: true, undo: true };
    } else if (tool === 'duplicates') {
      await until("return d.querySelectorAll('#duplicate-groups button').length===1;");
      await js("d.querySelector('#duplicate-groups button').click();");
      await until("return d.querySelectorAll('#file-rows tr').length===2;");
      await js(
        "d.querySelector('#file-rows input').click();d.querySelector('#trash-preview').click();",
      );
      await until("return d.querySelector('#file-review').open;");
      await delay(250);
      await fs.writeFile(path.join(dir, 'duplicate-review.png'), await capture(contents));
      await js("d.querySelector('#review-cancel').click();");
      report.fileTools.duplicates = { groups: 1, matchingCopies: 2, review: true };
    } else {
      await until("return d.querySelectorAll('#file-rows tr').length===2;");
      await js("d.querySelector('#file-results').scrollIntoView({block:'start'});");
      await delay(250);
      await fs.writeFile(path.join(dir, 'file-search.png'), await capture(contents));
      report.fileTools.search = { filteredResults: 2 };
    }
    await js("d.querySelector('#clear-files').click();");
    await until(
      "return d.querySelector('#file-results').hidden&&d.querySelector('#file-scopes').children.length===0;",
    );
    report.fileTools[tool].clear = true;
    report.fileTools[tool].locations = true;
    const debug = contents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    try {
      await js(
        "const input=d.createElement('input');input.type='file';input.id='drop-test';d.body.append(input);",
      );
      const { result } = await debug.sendCommand('Runtime.evaluate', {
        expression: `document.querySelector('#drop-test')`,
      });
      await debug.sendCommand('DOM.setFileInputFiles', {
        objectId: result.objectId,
        files: [path.join(fixture, 'document.txt')],
      });
      await js(
        "const input=d.querySelector('#drop-test'),transfer=new w.DataTransfer();transfer.items.add(input.files[0]);d.querySelector('#file-drop').dispatchEvent(new w.DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));input.remove();",
      );
      await until("return d.querySelector('#file-scopes').children.length===1;");
      report.fileTools[tool].drop = true;
      await js("d.querySelector('#clear-files').click();");
      await until("return d.querySelector('#file-scopes').children.length===0;");
    } finally {
      debug.detach();
    }
  } finally {
    dialog.showOpenDialog = original;
    await fs.rm(fixture, { recursive: true, force: true });
  }
};
