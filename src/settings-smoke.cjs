const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const capture = require('./smoke-capture.cjs');

module.exports = async function settingsSmoke({ window, views, navigate, dir }) {
  const hub = window.webContents;
  const js = (wc, code) =>
    wc.executeJavaScript(code).catch((error) => {
      throw Error('Settings check failed: ' + code + '\n' + error.message);
    });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(wc, code) {
    for (let i = 0; i < 100; i++) {
      if (await js(wc, code)) return;
      await delay(30);
    }
    throw Error('Settings check timed out: ' + code);
  }
  async function toggle(wc, key, value) {
    await until(wc, `!document.querySelector('[data-setting=${key}]').disabled`);
    await js(wc, `document.querySelector('[data-setting=${key}]').click()`);
    await until(wc, `(async()=> (await window.omnia.settings('get')).${key} === ${value})()`);
  }
  async function open(wc) {
    await js(hub, "document.querySelector('#settings').click()");
    await until(
      wc,
      "document.querySelector('#settings-panel').classList.contains('settings-visible')",
    );
    await delay(300);
  }
  async function close(wc) {
    const x = await js(
      wc,
      "Math.ceil(document.querySelector('#settings-panel').getBoundingClientRect().right) + 12",
    );
    for (const type of ['mouseDown', 'mouseUp'])
      wc.sendInputEvent({ type, x, y: 100, button: 'left', clickCount: 1 });
    await until(
      wc,
      "!document.querySelector('#settings-panel').open && document.querySelector('.settings-snapshot').hidden",
    );
  }
  async function dragSwitch(key, checked, fluid, cancel = false) {
    await until(hub, `!document.querySelector('[data-setting=${key}]').disabled`);
    const rect = await js(
      hub,
      `(()=>{const e=document.querySelector('[data-setting=${key}]'),r=e.nextElementSibling.getBoundingClientRect();return {x:r.x+(e.checked?28:10),y:r.y+11,checked:e.checked}})()`,
    );
    const x = Math.round(rect.x),
      y = Math.round(rect.y),
      end = x + (checked ? 28 : -28);
    hub.sendInputEvent({ type: 'mouseMove', x, y });
    hub.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await delay(220);
    const scale = await js(
      hub,
      `getComputedStyle(document.querySelector('[data-setting=${key}]').nextElementSibling,'::before').scale`,
    );
    assert.equal(Number(scale) > 1, fluid);
    const space = await js(
      hub,
      `(() => {
      const track = document.querySelector('[data-setting=${key}]').nextElementSibling;
      return track.closest('.settings-options > div').getBoundingClientRect().right - track.getBoundingClientRect().right;
    })()`,
    );
    assert.ok(space >= 7, 'Pressed switch and focus ring must fit inside the options');
    for (let i = 1; i <= 6; i++) {
      hub.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(x + ((end - x) * i) / 6),
        y,
        button: 'left',
        modifiers: ['leftButtonDown'],
      });
      await delay(20);
    }
    if (cancel) await js(hub, "dispatchEvent(new Event('blur'))");
    hub.sendInputEvent({ type: 'mouseUp', x: end, y, button: 'left', clickCount: 1 });
    const expected = cancel ? rect.checked : checked;
    await until(hub, `(async()=> (await window.omnia.settings('get')).${key} === ${expected})()`);
    await delay(100);
    assert.equal(
      await js(hub, `document.querySelector('[data-setting=${key}]').checked`),
      expected,
    );
  }
  async function clickSwitch(key, checked) {
    const point = await js(
      hub,
      `(()=>{const r=document.querySelector('[data-setting=${key}]').nextElementSibling.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    hub.sendInputEvent({ type: 'mouseMove', ...point });
    hub.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    hub.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await until(hub, `(async()=> (await window.omnia.settings('get')).${key} === ${checked})()`);
    await delay(100);
    assert.equal(await js(hub, `document.querySelector('[data-setting=${key}]').checked`), checked);
  }
  const original = await js(hub, "window.omnia.settings('get')");
  try {
    await js(
      hub,
      "window.omnia.settings('update',{enabled:true,insignia:true,transitions:true,details:true})",
    );
    await navigate('home');
    const logo = (await fs.readFile(path.join(__dirname, '../assets/logo.txt'), 'utf8')).replace(
      /\r?\n$/,
      '',
    );
    assert.equal(await js(hub, "document.querySelector('.ascii').textContent"), logo);
    assert.equal(await js(hub, "document.querySelectorAll('.ascii-letter').length"), 10);
    await open(hub);
    const panel = await js(
      hub,
      `(()=>{const d=document.querySelector('#settings-panel'),r=d.getBoundingClientRect();return {width:r.width,left:r.left,top:r.top,height:r.height,viewport:innerWidth,viewportHeight:innerHeight,blur:getComputedStyle(d,'::backdrop').backdropFilter}})()`,
    );
    assert.ok(panel.width < panel.viewport && Math.abs(panel.left) < 2);
    assert.match(panel.blur, /blur/);
    assert.equal(panel.top, 0);
    assert.equal(panel.height, panel.viewportHeight);
    await fs.writeFile(path.join(dir, 'settings-hub.png'), await capture(hub));
    await dragSwitch('insignia', false, true);
    await dragSwitch('insignia', true, true);
    await dragSwitch('insignia', false, true, true);
    await clickSwitch('insignia', false);
    await clickSwitch('insignia', true);
    await toggle(hub, 'insignia', false);
    assert.equal(
      await js(
        hub,
        "[...document.querySelectorAll('[data-insignia]')].flatMap(e=>e.getAnimations({subtree:true})).length",
      ),
      0,
    );
    await toggle(hub, 'details', false);
    await dragSwitch('insignia', true, false);
    await dragSwitch('insignia', false, false);
    assert.equal(
      await js(hub, "getComputedStyle(document.querySelector('.ascii-source')).visibility"),
      'visible',
    );
    assert.equal(
      await js(hub, "getComputedStyle(document.querySelector('.ascii-letter')).display"),
      'none',
    );
    await toggle(hub, 'transitions', false);
    await close(hub);
    await navigate('mp3');
    assert.equal(views.lastTransition().frames, 1);
    assert.equal(views.lastTransition().durationMs, 0);
    const mp3 = views.get('mp3');
    await js(mp3, "document.querySelector('#edit-volume').value='3'");
    await open(hub);
    assert.equal(await js(mp3, "document.querySelector('#settings-panel').open"), false);
    assert.equal(views.covered(), true);
    assert.equal(await js(hub, "document.querySelector('.settings-snapshot').hidden"), false);
    await fs.writeFile(path.join(dir, 'settings-tool.png'), await capture(hub));
    await toggle(hub, 'enabled', false);
    assert.equal(await js(hub, "document.querySelector('.settings-options').inert"), true);
    assert.equal(
      await js(hub, "document.querySelector('.settings-options').getBoundingClientRect().height"),
      0,
    );
    assert.equal(await js(mp3, 'document.getAnimations().length'), 0);
    assert.equal(await js(hub, 'document.getAnimations().length'), 0);
    await close(hub);
    assert.equal(await js(mp3, "document.querySelector('#edit-volume').value"), '3');
    await open(hub);
    await fs.writeFile(path.join(dir, 'settings-disabled.png'), await capture(hub));
    await toggle(hub, 'enabled', true);
    assert.deepEqual(await js(mp3, "window.omnia.settings('get')"), {
      enabled: true,
      insignia: false,
      transitions: false,
      details: false,
    });
    await toggle(hub, 'insignia', true);
    await close(hub);
    await navigate('mp4');
    assert.equal(views.lastTransition().frames, 1);
    const mp4 = views.get('mp4');
    await until(mp4, "document.documentElement.dataset.insigniaMotion==='on'");
    assert.equal(
      await js(mp4, "getComputedStyle(document.querySelector('.film-track')).animationName"),
      'film-scroll',
    );
    await open(hub);
    hub.debugger.attach('1.3');
    try {
      await hub.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await until(hub, "document.documentElement.dataset.animations==='off'");
      assert.equal(await js(hub, "document.querySelector('#settings-reduced').hidden"), false);
      assert.equal(await js(hub, 'document.getAnimations().length'), 0);
      await hub.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    } finally {
      hub.debugger.detach();
    }
    await close(hub);
    await navigate('home');
    await js(
      hub,
      "window.omnia.settings('update',{enabled:true,insignia:true,transitions:true,details:true})",
    );
    window.show();
    window.moveTop();
    window.focus();
    await until(hub, '!document.hidden');
    await delay(150);
    const first = await js(
      hub,
      "getComputedStyle(document.querySelector('.ascii-letter')).transform",
    );
    await delay(220);
    assert.notEqual(
      await js(hub, "getComputedStyle(document.querySelector('.ascii-letter')).transform"),
      first,
      JSON.stringify({
        active: views.active(),
        covered: views.covered(),
        state: await js(
          hub,
          `({classes:document.body.className,active:document.body.dataset.activeTool,settings:{...document.documentElement.dataset},hidden:document.hidden,animation:getComputedStyle(document.querySelector('.ascii-letter')).animation,display:getComputedStyle(document.querySelector('.ascii-letter')).display})`,
        ),
      }),
    );
    assert.equal(await js(hub, "document.querySelector('.ascii').textContent"), logo);
    await fs.writeFile(path.join(dir, 'settings-wave.png'), await capture(hub));
    await open(hub);
    hub.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    hub.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(hub, "!document.querySelector('#settings-panel').open");
    return {
      hub: true,
      toolOverlay: true,
      fullHeightOverlay: true,
      dragSwitches: true,
      cancelDrag: true,
      pointerClick: true,
      detailMotionGated: true,
      independentToggles: true,
      masterStopsMotion: true,
      snapTransitions: true,
      savedSubsettings: true,
      preservesToolInputs: true,
      logoPreserved: true,
      wave: true,
      reducedMotion: true,
      escape: true,
    };
  } finally {
    await js(hub, `window.omnia.settings('update',${JSON.stringify(original)})`);
    await js(hub, 'window.omniaSettings.close(true)');
    await until(hub, "document.querySelector('.settings-snapshot').hidden");
    await navigate('home');
  }
};
