// OMNIA_SMOKE harness.
const fs = require('node:fs/promises');
const path = require('node:path');
const capture = require('./smoke-capture.cjs');
async function smoke({ app, window, server, workbench, visibleMs, introFrames, views }) {
  const dir = path.join(process.cwd(), '.qa');
  await fs.mkdir(dir, { recursive: true });
  const auth = await fetch(server.url, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const samples = 22050;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(88200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(Math.sin((i / 44100) * 440 * Math.PI * 2) * 10000), 44 + i * 2);
  const uploaded = await fetch(server.origin + '/api/jobs?name=smoke.wav&bitrate=192', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Omnia': '1' },
    body: wav,
  });
  if (uploaded.status !== 202) throw new Error(await uploaded.text());
  const { id } = await uploaded.json();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (
      await fetch(`${server.origin}/api/jobs/${id}`, { headers: { Cookie: cookie } })
    ).json();
    if (['done', 'error'].includes(result.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (result.state !== 'done') throw new Error(result.error || 'Packaged conversion timed out');
  const download = await fetch(`${server.origin}/api/jobs/${id}/download`, {
    headers: { Cookie: cookie },
  });
  const mp3 = Buffer.from(await download.arrayBuffer());
  if (download.status !== 200 || mp3.length < 1000) throw new Error('Invalid MP3 output');
  await fs.writeFile(
    path.join(dir, app.isPackaged ? 'packaged-desktop.png' : 'desktop.png'),
    await capture(window.webContents),
  );
  const report = {
    packaged: app.isPackaged,
    visibleMs,
    bounds: window.getBounds(),
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    title: window.getTitle(),
    conversion: result.state,
    mp3Bytes: mp3.length,
    logo: await window.webContents.executeJavaScript(
      'document.querySelector(".ascii").textContent',
    ),
    introFinished: await window.webContents.executeJavaScript(
      '!document.body.classList.contains("booting")',
    ),
    toolCount: await window.webContents.executeJavaScript(
      '[...document.querySelectorAll(".tool-card")].filter(e=>!e.closest("[hidden]")).length',
    ),
  };
  if (
    !report.visible ||
    report.minimized ||
    !report.introFinished ||
    ![require('../assets/tools.json').length - 1, require('../assets/tools.json').length].includes(
      report.toolCount,
    )
  )
    throw new Error(
      'Launcher visibility, animation or directory check failed: ' + JSON.stringify(report),
    );
  if (introFrames?.length) {
    const gaps = introFrames
      .slice(1)
      .map((frame, i) => frame.at - introFrames[i].at)
      .sort((a, b) => a - b);
    report.expansion = {
      frames: introFrames.length,
      durationMs: Math.round(introFrames.at(-1).at - introFrames[0].at),
      medianFrameMs: Math.round(gaps[Math.floor(gaps.length / 2)] || 0),
      maxFrameMs: Math.round(gaps.at(-1) || 0),
      topEdgeStable: introFrames.every((frame) => frame.y === introFrames[0].y),
      monotonic: introFrames.every(
        (frame, i) => i === 0 || frame.height >= introFrames[i - 1].height,
      ),
    };
    if (!report.expansion.topEdgeStable || !report.expansion.monotonic)
      throw new Error('Window expansion moved or reversed unexpectedly.');
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rootJS = (code) => window.webContents.executeJavaScript(code);
  const navigate = async (id) => {
    await rootJS('window.omnia.openTool(' + JSON.stringify(id) + ')');
    await delay(250);
  };
  report.settings = await require('./settings-smoke.cjs')({ window, views, navigate, dir });
  report.nativeTools = [];
  report.adminCards = await rootJS(
    "[...document.querySelectorAll('.tool-title>.admin-indicator')].map(e=>({id:e.closest('.tool-card').dataset.tool,mode:e.dataset.admin}))",
  );
  if (
    report.adminCards.length !== 5 ||
    report.adminCards.some((e) => ['mp3', 'mp4', 'gif'].includes(e.id))
  )
    throw Error('Administrator card indicators differ.');
  report.categoryFonts = await rootJS(
    "[...new Set([...document.querySelectorAll('.category-heading')].map(e=>getComputedStyle(e).fontSize))]",
  );
  if (report.categoryFonts.length !== 1) throw Error('Category typography differs.');
  await fs.writeFile(path.join(dir, 'admin-directory.png'), await capture(window.webContents));
  for (const tool of require('../assets/tools.json')) {
    await navigate(tool.id);
    const wc = views.get(tool.id);
    if (!wc)
      throw Error(
        'Tool did not open: ' +
          tool.id +
          ' ' +
          JSON.stringify(await rootJS("window.omnia.toolHealth('status')")),
      );
    await delay(700);
    const state = await wc.executeJavaScript(
      "({tool:document.body.dataset.tool,native:document.body.classList.contains('native-tool'),insignia:!!document.querySelector('.page-insignia')?.children.length,settings:!!document.querySelector('#settings-panel'),overflow:document.documentElement.scrollWidth>innerWidth,admin:document.querySelector('.admin-indicator')?.dataset.admin||null})",
    );
    if (
      state.tool !== tool.id ||
      !state.native ||
      !state.insignia ||
      !state.settings ||
      state.overflow ||
      state.admin !== (tool.admin || null)
    )
      throw Error('Tool interface check failed: ' + JSON.stringify(state));
    if (wc.getOSProcessId() === window.webContents.getOSProcessId())
      throw Error('Tool shares the directory renderer.');
    report.nativeTools.push({
      ...state,
      pid: wc.getOSProcessId(),
      transition: views.lastTransition(),
    });
    if (tool.id === 'ssh') await require('./ssh-smoke.cjs')({ window, contents: wc, dir, report });
    if (['rename', 'duplicates', 'search'].includes(tool.id))
      await require('./file-tools-smoke.cjs')({ tool: tool.id, contents: wc, dir, report });
    if (tool.id === 'firewall')
      await fs.writeFile(path.join(dir, 'admin-firewall.png'), await capture(wc));
    await navigate('home');
    report.homeTransition = views.lastTransition();
  }
  const faults = await rootJS("window.omnia.toolHealth('status')");
  if (faults.length) throw Error('Unexpected quarantined tools: ' + JSON.stringify(faults));
  await navigate('ssh');
  const keyView = views.get('ssh');
  await keyView
    .executeJavaScript("dispatchEvent(new ErrorEvent('error',{message:'Fixture fault'}))")
    .catch(() => {});
  for (let i = 0; i < 100 && views.active() !== 'home'; i++) await delay(100);
  if (views.active() !== 'home') throw Error('Tool error did not return to directory.');
  await navigate('mp3');
  await navigate('home');
  await rootJS("window.omnia.toolHealth('reset',{id:'ssh'})");
  await navigate('ssh');
  views.get('ssh').forcefullyCrashRenderer();
  for (let i = 0; i < 100 && views.active() !== 'home'; i++) await delay(100);
  if (views.active() !== 'home') throw Error('Tool renderer crash was not isolated.');
  await rootJS("window.omnia.toolHealth('reset',{id:'ssh'})");
  await navigate('ssh');
  void views
    .get('ssh')
    .executeJavaScript('while(true){}')
    .catch(() => {});
  if ((await rootJS('1+1')) !== 2) throw Error('Directory stopped responding.');
  for (let i = 0; i < 170 && views.active() !== 'home'; i++) await delay(100);
  if (views.active() !== 'home') throw Error('Hung tool renderer was not stopped.');
  await rootJS("window.omnia.toolHealth('reset',{id:'ssh'})");
  report.toolRecovery = {
    pageError: true,
    rendererCrash: true,
    rendererHang: true,
    directoryResponsive: true,
  };
  report.rendererRecovery = true;
  await navigate('network');
  report.transition = views.lastTransition();
  window.emit('app-command', {}, 'browser-backward');
  await delay(750);
  if (views.active() !== 'home') throw Error('Mouse back failed.');
  window.emit('app-command', {}, 'browser-forward');
  await delay(750);
  if (views.active() !== 'network') throw Error('Mouse forward failed.');
  await views
    .get('network')
    .executeJavaScript(
      "dispatchEvent(new MouseEvent('mouseup',{button:3,bubbles:true,cancelable:true}))",
    );
  await delay(750);
  if (views.active() !== 'home') throw Error('Mouse back inside a tool failed.');
  await rootJS("dispatchEvent(new MouseEvent('mouseup',{button:4,bubbles:true,cancelable:true}))");
  await delay(750);
  if (views.active() !== 'network') throw Error('Mouse forward from the directory failed.');
  views
    .get('network')
    .emit(
      'before-input-event',
      { preventDefault() {} },
      { key: 'ArrowLeft', alt: true, type: 'keyDown' },
    );
  await delay(750);
  if (views.active() !== 'home') throw Error('Keyboard back inside a tool failed.');
  window.webContents.emit(
    'before-input-event',
    { preventDefault() {} },
    { key: 'ArrowRight', alt: true, type: 'keyDown' },
  );
  await delay(750);
  if (views.active() !== 'network') throw Error('Keyboard forward failed.');
  await navigate('home');
  report.backNavigation = [
    'app-command back/forward',
    'tool mouse back',
    'directory mouse forward',
    'Alt+Left/Right',
  ];
  report.workbench = await require('./workbench-smoke.cjs')({ window, views, navigate, dir });
  report.inputFeedback = await require('./input-smoke.cjs')({ views, navigate, dir, wav });
  await fs.writeFile(
    path.join(dir, app.isPackaged ? 'packaged-smoke.json' : 'smoke.json'),
    JSON.stringify(report, null, 2),
  );
}
module.exports = smoke;
