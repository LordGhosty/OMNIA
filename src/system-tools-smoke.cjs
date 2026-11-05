const fs = require('node:fs/promises'),
  path = require('node:path');
module.exports = async ({ tool, window, dir, report }) => {
  const js = (code) =>
      window.webContents.executeJavaScript(
        `(()=>{const w=document.querySelector('iframe[data-tool="${tool}"]').contentWindow,d=w.document;${code}})()`,
      ),
    delay = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(code) {
    for (let i = 0; i < 500; i++) {
      if (await js(code)) return;
      await delay(100);
    }
    throw Error(
      tool +
        ' did not finish loading: ' +
        (await js(
          "return d.querySelector('#system-status')?.textContent+' / '+d.querySelector('#scan-metrics')?.textContent+' / rows='+d.querySelector('#disk-rows')?.children.length+' / hidden='+d.hidden;",
        )),
    );
  }
  report.systemTools ??= {};
  if (tool === 'diskspace') {
    await until("return d.querySelectorAll('.disk-card').length>0;");
    const fixture = path.join(dir, 'disk-space-fixture');
    await fs.mkdir(path.join(fixture, 'Documents'), { recursive: true });
    await fs.mkdir(path.join(fixture, 'Media'), { recursive: true });
    for (const [file, size] of [
      ['Documents/report.pdf', 180000],
      ['Media/clip.mp4', 560000],
      ['Media/photo.png', 240000],
      ['bundle.zip', 320000],
    ])
      await fs.writeFile(path.join(fixture, file), Buffer.alloc(size));
    const { dialog } = require('electron'),
      original = dialog.showOpenDialog;
    try {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
      window.minimize();
      await delay(100);
      await js("d.querySelector('#choose-scan-folder').click();");
      await until(
        "return d.querySelector('#scan-metrics').textContent.includes('COMPLETE')&&d.querySelector('#disk-rows').children.length===3;",
      );
      window.restore();
      window.show();
      await js("d.querySelector('#scan-panel').scrollIntoView({block:'start'});");
      await delay(300);
      await fs.writeFile(
        path.join(dir, 'disk-space.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      if (
        !(await js(
          "return d.querySelectorAll('#category-bar .storage-segment').length===4&&d.querySelectorAll('#category-legend span').length===4;",
        ))
      )
        throw Error('Storage category graph is incomplete.');
      await js(
        "[...d.querySelectorAll('#disk-rows button')].find(b=>b.textContent.includes('Media')).click();",
      );
      await until("return d.querySelector('#scan-title').textContent==='Media';");
      report.systemTools.diskspace = {
        graph: true,
        drillDown: true,
        disks: await js("return d.querySelectorAll('#disk-cards > .disk-card').length;"),
      };
    } finally {
      dialog.showOpenDialog = original;
    }
  }
  if (tool === 'repair') {
    await until(
      "return d.querySelectorAll('[data-repair-task]').length===7&&d.querySelector('#repair-volume').options.length>1;",
    );
    await delay(250);
    await fs.writeFile(
      path.join(dir, 'windows-repair.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    try {
      await js(
        "w.testBridge=w.omnia;w.omnia={...w.omnia,repair:async(action,data)=>{if(action==='prepare')return {token:'fixture',name:'Verify system files',description:'Check protected files.',command:'sfc /verifyonly'};if(action==='execute')throw Error('Repair execution is forbidden in this UI test.');return w.testBridge.repair(action,data);}};",
      );
      window.webContents.send('omnia:admin-state', { enabled: true, supported: true });
      await delay(100);
      await js('d.querySelector(\'[data-repair-task="sfc-check"]\').click();');
      await until("return d.querySelector('#repair-confirm').open;");
      report.systemTools.repair = {
        cards: 7,
        review: await js(
          "return d.querySelector('#repair-command').textContent==='sfc /verifyonly';",
        ),
      };
      await js("d.querySelector('#repair-cancel').click();");
    } finally {
      await js('if(w.testBridge){w.omnia=w.testBridge;delete w.testBridge;}');
      window.webContents.send('omnia:admin-state', { enabled: false, supported: true });
    }
  }
  if (tool === 'firewall') {
    await until(
      "return d.querySelector('#firewall-progress').hidden&&d.querySelectorAll('#firewall-rows tr').length>0;",
    );
    await js("d.querySelector('#firewall-rows button').click();");
    await until(
      "return d.querySelector('#firewall-progress').hidden&&d.querySelector('#firewall-detail').children.length>0;",
    );
    await js("d.querySelector('#firewall-count').scrollIntoView({block:'start'});");
    await delay(250);
    await fs.writeFile(
      path.join(dir, 'firewall-manager.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    try {
      await js(
        "w.testBridge=w.omnia;w.omnia={...w.omnia,firewall:async(action,data)=>{if(action==='prepare')return {token:'fixture',operation:data.operation,summary:{after:data.spec}};if(action==='execute')throw Error('Firewall mutation is forbidden in this UI test.');return w.testBridge.firewall(action,data);}};",
      );
      window.webContents.send('omnia:admin-state', { enabled: true, supported: true });
      await delay(100);
      await js(
        "d.querySelector('#firewall-new').click();d.querySelector('#fw-name').value='UI test rule';d.querySelector('#fw-local-port').value='443';d.querySelector('#fw-editor-review').click();",
      );
      await until("return d.querySelector('#firewall-confirm').open;");
      report.systemTools.firewall = {
        profiles: await js("return d.querySelector('#firewall-profiles').children.length;"),
        details: true,
        review: await js("return d.querySelector('#firewall-plan').textContent.includes('443');"),
      };
      await js("d.querySelector('#fw-confirm-cancel').click();");
    } finally {
      await js('if(w.testBridge){w.omnia=w.testBridge;delete w.testBridge;}');
      window.webContents.send('omnia:admin-state', { enabled: false, supported: true });
    }
  }
};
