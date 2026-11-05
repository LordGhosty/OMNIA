const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const capture = require('./smoke-capture.cjs');

module.exports = async ({ views, navigate, dir, wav }) => {
  const png = path.join(dir, 'input-image.png'),
    audio = path.join(dir, 'input-audio.wav'),
    empty = path.join(dir, 'input-empty.wav'),
    fake = path.join(dir, 'input-renamed.mp4'),
    text = path.join(dir, 'input-text.txt');
  await fs.copyFile(path.join(__dirname, '../assets/app-icon.png'), png);
  await fs.copyFile(png, fake);
  await fs.writeFile(audio, wav);
  await fs.writeFile(empty, '');
  await fs.writeFile(text, 'Fixture text.');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (code) => views.get(views.active()).executeJavaScript(code);
  async function until(code) {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await delay(100);
    }
    throw Error('Input feedback timeout: ' + code);
  }
  async function select(files, drop = false) {
    const debug = views.get(views.active()).debugger;
    debug.attach('1.3');
    try {
      if (drop)
        await js(
          `(()=>{const e=document.createElement('input');e.type='file';e.multiple=true;e.id='input-fixture';document.body.append(e)})()`,
        );
      const { result } = await debug.sendCommand('Runtime.evaluate', {
        expression: `document.querySelector('${drop ? '#input-fixture' : '#file'}')`,
      });
      await debug.sendCommand('DOM.setFileInputFiles', { objectId: result.objectId, files });
      if (drop)
        await js(
          `(()=>{const e=document.querySelector('#input-fixture'),data=new DataTransfer();for(const file of e.files)data.items.add(file);document.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));e.remove()})()`,
        );
    } finally {
      debug.detach();
    }
  }
  const note = () => js("document.querySelector('.input-feedback:not([hidden])')?.textContent||''");
  await navigate('mp3');
  await select([png]);
  assert.match(await note(), /Wrong file format/);
  await select([png], true);
  assert.match(await note(), /Wrong file format/);
  await select([audio, png], true);
  assert.match(await note(), /one file/);
  await select([empty]);
  assert.match(await note(), /empty/);
  await js(
    "(()=>{const file=new File(['x'],'large.wav');Object.defineProperty(file,'size',{value:2*1024**3+1});choose(file)})()",
  );
  assert.match(await note(), /too large/);
  await select([audio]);
  await until("document.querySelector('#status').textContent==='Ready.'");
  assert.equal(await note(), '');
  await select([png]);
  assert.equal(await js("document.querySelector('#convert').disabled"), false);
  assert.match(await js("document.querySelector('#source-summary').textContent"), /input-audio/);
  await delay(300);
  await fs.writeFile(path.join(dir, 'input-rejection.png'), await capture(views.get('mp3')));
  await select([fake]);
  await until(
    "!!document.querySelector('#drop-zone[aria-invalid=true]')&&!document.querySelector('#file').disabled",
  );
  assert.match(await note(), /Images/);
  assert.equal(await js("document.querySelector('#convert').disabled"), true);
  const debug = views.get('mp3').debugger;
  debug.attach('1.3');
  try {
    await debug.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await js("choose(new File(['x'],'wrong.png',{type:'image/png'}))");
    assert.equal(await js("document.querySelector('#drop-zone').getAnimations().length"), 0);
    assert.match(await note(), /Wrong file format/);
  } finally {
    await debug.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    debug.detach();
  }
  for (const tool of ['images', 'metadata']) {
    await navigate(tool);
    await select([text], true);
    await until("!!document.querySelector('#choose-files[aria-invalid=true]')");
    assert.match(await note(), /rejected|unsupported/i);
    await js("document.querySelector('#clear-files').click()");
    await until("!document.querySelector('#choose-files[aria-invalid=true]')");
  }
  await navigate('ssh');
  await select([png], true);
  await until("!!document.querySelector('#ssh-drop[aria-invalid=true]')");
  assert.ok((await note()).length > 0);
  await navigate('home');
  return {
    browse: true,
    drop: true,
    count: true,
    empty: true,
    sizeLimit: true,
    contents: true,
    preservedSelection: true,
    reducedMotion: true,
    images: true,
    metadata: true,
    ssh: true,
  };
};
