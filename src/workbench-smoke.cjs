// Workbench smoke checks.
const fs = require('node:fs/promises');
const path = require('node:path');
const capture = require('./smoke-capture.cjs');
module.exports = async ({ window, views, navigate, dir }) => {
  const { dialog } = require('electron');
  const originalOpen = dialog.showOpenDialog,
    originalSave = dialog.showSaveDialog;
  const source = path.join(dir, 'workbench-source.png');
  await fs.copyFile(path.join(__dirname, '../assets/app-icon.png'), source);
  const screenshot = async (name) => {
    await new Promise((r) => setTimeout(r, 220));
    await fs.writeFile(path.join(dir, name), await capture(views.get(views.active())));
  };
  const js = (tool, expression) =>
    views.get(tool).executeJavaScript(`(()=>{const w=window;const d=document;${expression}})()`);
  async function wait(tool) {
    for (let i = 0; i < 300; i++) {
      if (
        await js(
          tool,
          `return !d.querySelector('#choose-files').disabled&&!d.querySelector('#file-result-actions').hidden;`,
        )
      )
        return;
      const status = await js(tool, `return d.querySelector('#file-status').textContent;`);
      if (i === 299) throw Error('File interface timeout: ' + status);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function drop(tool, files) {
    const debug = views.get(tool).debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    try {
      // Native file-drop bridge.
      await js(
        tool,
        `const input=d.createElement('input');input.type='file';input.multiple=true;input.id='smoke-drop-input';d.body.append(input);`,
      );
      const { result } = await debug.sendCommand('Runtime.evaluate', {
        expression: `document.querySelector('#smoke-drop-input')`,
      });
      await debug.sendCommand('DOM.setFileInputFiles', { objectId: result.objectId, files });
      await js(
        tool,
        `const input=d.querySelector('#smoke-drop-input'),data=new w.DataTransfer();for(const file of input.files)data.items.add(file);d.dispatchEvent(new w.DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));input.remove();`,
      );
      await wait(tool);
    } finally {
      debug.detach();
    }
  }
  async function clear(tool) {
    await js(tool, `d.querySelector('#clear-files').click();`);
    for (let i = 0; i < 100; i++) {
      if (
        await js(
          tool,
          `return !d.querySelector('#choose-files').disabled&&d.querySelector('#file-sidebar').hidden&&d.querySelector('#file-result-actions').hidden&&!d.querySelector('#file-queue').children.length;`,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Clear did not reset ' + tool);
  }
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    await navigate('images');
    await screenshot('image-drop-area.png');
    await js('images', `d.querySelector('#choose-files').click();`);
    await wait('images');
    await js(
      'images',
      `d.querySelector('#crop-ratio').value='1';d.querySelector('#crop-ratio').dispatchEvent(new w.Event('change'));d.querySelector('#image-width').value='256';d.querySelector('#output-format').value='webp';d.querySelector('#output-format').dispatchEvent(new w.Event('change'));`,
    );
    await screenshot('image-workshop.png');
    await js('images', `d.querySelector('#convert-images').click();`);
    await wait('images');
    if (
      !(await js(
        'images',
        `return d.querySelector('#preview-size').textContent.includes('256 × 256');`,
      ))
    )
      throw Error('Image UI conversion dimensions failed.');
    const exported = path.join(dir, 'workbench-export-' + Date.now() + '.webp');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported });
    await js('images', `d.querySelector('#save-file').click();`);
    for (let n = 0; n < 100; n++) {
      try {
        await fs.stat(exported);
        break;
      } catch {
        if (n === 99) throw Error('Image UI did not save.');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await clear('images');
    await drop('images', [source, exported]);
    if (
      !(await js(
        'images',
        `return d.querySelector('#queue-count').textContent==='2'&&d.querySelector('#image-width').value==='';`,
      ))
    )
      throw Error('Batch drop or reset failed.');
    await clear('images');
    await navigate('metadata');
    await drop('metadata', [source]);
    const notes = 'OMNIA notes\nΓειά σου 🌍\nThese notes live inside this image.';
    await js(
      'metadata',
      `d.querySelector('#meta-notes').value=${JSON.stringify(notes)};d.querySelector('#meta-title').value='A note inside an image';d.querySelector('#write-metadata').click();`,
    );
    if (!(await js('metadata', `return d.querySelector('#metadata-confirm').open;`)))
      throw Error('Metadata change preview did not open.');
    await js('metadata', `d.querySelector('#metadata-apply').click();`);
    await wait('metadata');
    if (
      !(await js(
        'metadata',
        `return d.querySelector('#meta-notes').value===${JSON.stringify(notes)};`,
      ))
    )
      throw Error('Metadata UI notes did not round-trip.');
    await js('metadata', `d.querySelector('#metadata-options').scrollIntoView({block:'start'});`);
    await screenshot('image-metadata.png');
    if (
      !(await js(
        'metadata',
        `const actions=d.querySelector('#file-result-actions'),queue=d.querySelector('#file-queue-panel');return actions.parentElement===queue.parentElement&&actions.getBoundingClientRect().top>=queue.getBoundingClientRect().bottom;`,
      ))
    )
      throw Error('Save/report actions are not below Files.');
    await clear('metadata');
    if (
      !(await js(
        'metadata',
        `return d.querySelector('#meta-notes').value===''&&!d.querySelector('#image-preview').hasAttribute('src');`,
      ))
    )
      throw Error('Metadata clear retained notes or preview.');
    await navigate('inspector');
    await drop('inspector', [source]);
    const digest = require('node:crypto')
      .createHash('sha256')
      .update(await fs.readFile(source))
      .digest('hex');
    await js(
      'inspector',
      `d.querySelector('#expected-checksum').value='${digest}';d.querySelector('#expected-checksum').dispatchEvent(new w.Event('input'));`,
    );
    if (
      !(await js(
        'inspector',
        `return d.querySelector('#checksum-result').textContent.startsWith('MATCH');`,
      ))
    )
      throw Error('Inspector UI checksum failed.');
    await screenshot('file-inspector.png');
    await clear('inspector');
    await fs.stat(exported);
    await fs.stat(source);
    await navigate('home');
    return {
      conversion: true,
      save: true,
      metadataNotes: true,
      checksum: true,
      dropFiles: true,
      batchDrop: true,
      clear: true,
      sidebarActions: true,
    };
  } finally {
    dialog.showOpenDialog = originalOpen;
    dialog.showSaveDialog = originalSave;
  }
};
