const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  screen,
  clipboard,
  dialog,
  utilityProcess,
} = require('electron');
const path = require('node:path');
const { startServer } = require('./server.cjs');
// Detached console streams.
for (const stream of [process.stdout, process.stderr]) stream?.on('error', () => {});
const registry = require('../assets/tools.json');
const serviceProcesses = [];
let views,
  window,
  server,
  admin,
  drives,
  driverInspector,
  diskSpace,
  fileTools,
  sshKeys,
  toolHost,
  firewall,
  repair,
  workbench,
  validation,
  validationTimer,
  deviceTimer,
  quitting = false;
if (process.env.OMNIA_SMOKE === '1')
  app.setPath('userData', path.join(process.cwd(), '.qa', 'smoke-profile'));
if (!app.omniaLock && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!quitting && window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const settings = await require('./settings.cjs').createSettings(
        path.join(app.getPath('userData'), 'settings.json'),
        (state) => views?.broadcast('omnia:settings-state', state),
      );
      toolHost = require('./tool-health.cjs').createToolHost(
        (state) => {
          if (window && !window.isDestroyed()) window.webContents.send('omnia:tool-health', state);
        },
        {
          statePath: path.join(app.getPath('userData'), 'tool-quarantine.json'),
          buildId: require('../assets/build-id.json').id,
        },
      );
      admin = require('./admin.cjs').createAdmin({
        onChange: (state) => {
          broadcast('omnia:admin-state', state);
          for (const service of services) service.updateAdmin(state);
        },
      });
      const services = serviceProcesses;
      const trashReview = require('./trash-review.cjs').createTrashReview({
        remove: (file) => shell.trashItem(file),
        isActive: () => views?.active() === 'duplicates' && !quitting,
        confirm: async (plan) => {
          const result = await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'OMNIA · Move duplicates to Recycle Bin',
            message: `Move ${plan.rows.length} selected copies to the Recycle Bin?`,
            detail: plan.rows.map((row) => row.from).join('\n'),
            buttons: ['Cancel', 'Move to Recycle Bin'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return result.response === 1;
        },
      });
      const systemRequest = require('./system-broker.cjs').createSystemBroker({
        admin,
        backupRoot: path.join(app.getPath('userData'), 'driver-backups'),
        isActive: (id) => views?.active() === id && !quitting,
        confirm: async (request) => {
          const result = await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'OMNIA · Confirm system operation',
            message: request.title,
            detail: request.detail,
            buttons: ['Cancel', 'Continue'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return result.response === 1;
        },
      });
      const createService = async (ids, kind) =>
        toolHost.register(ids, () => {
          const service = require('./process-host.cjs').createProcessService({
            kind,
            options: {
              tool: ids[0],
              userData: app.getPath('userData'),
              places:
                kind === 'files'
                  ? [
                      'home',
                      'desktop',
                      'downloads',
                      'documents',
                      'pictures',
                      'music',
                      'videos',
                    ].flatMap((name) => {
                      try {
                        return [
                          { name: name[0].toUpperCase() + name.slice(1), path: app.getPath(name) },
                        ];
                      } catch {
                        return [];
                      }
                    })
                  : undefined,
              adminState: admin.status(),
              helper: app.isPackaged
                ? path.join(process.resourcesPath, 'bin/omnia-askpass.exe')
                : path.join(__dirname, '../vendor/win32/omnia-askpass.exe'),
            },
            fork: (...args) => utilityProcess.fork(...args),
            guard:
              process.platform === 'win32'
                ? (pid, onExit) =>
                    require('./process-guard.cjs').guardProcess(
                      app.isPackaged
                        ? path.join(process.resourcesPath, 'bin/omnia-process-guard.exe')
                        : path.join(__dirname, '../vendor/win32/omnia-process-guard.exe'),
                      pid,
                      { onExit },
                    )
                : undefined,
            onFault: (reason) => {
              toolHost.fail(ids, reason);
              for (const id of ids) views?.fail(id, reason);
            },
            onEvent: (name, data) => {
              if (ids[0] !== 'drives') throw Error('This tool cannot send drive events.');
              if (name === 'drives') broadcast('omnia:drives-state', data);
              if (name === 'insert' && data.action === 'show-tool') void openTool('drives');
              else if (name === 'insert' && data.action?.kind === 'custom')
                void drives
                  .insertionTask(data.disk, data.action)
                  .catch((error) => notify(error.message));
            },
            broker: async (action, data, progress) => {
              require('./access.cjs').brokerAccess(ids[0], action);
              if (ids[0] === 'duplicates' && action === 'trash')
                return trashReview.remove(data.file);
              return systemRequest(ids[0], action, data, progress);
            },
          });
          services.push(service);
          return service;
        });
      const group = require('./tool-group.cjs').createToolGroup;
      workbench = group(
        {
          images: await createService(['images'], 'workbench'),
          metadata: await createService(['metadata'], 'workbench'),
          inspector: await createService(['inspector'], 'workbench'),
        },
        {
          select: 'tool',
          clear: 'tool',
          start: 'tool',
          source: 'tool',
          status: 'owner',
          cancel: 'owner',
          asset: 'owner',
          save: 'owner',
          saveBatch: 'owners',
        },
      );
      sshKeys = await createService(['ssh'], 'ssh');
      diskSpace = await createService(['diskspace'], 'diskspace');
      fileTools = group(
        {
          rename: await createService(['rename'], 'files'),
          duplicates: await createService(['duplicates'], 'files'),
          search: await createService(['search'], 'files'),
        },
        {
          status: 'tool',
          query: 'tool',
          cancel: 'tool',
          location: 'tool',
          clear: 'tool',
          select: 'tool',
          start: 'tool',
          prepareRename: 'rename',
          roots: 'tool',
          folders: 'tool',
          remove: 'tool',
          prepareUndo: 'rename',
          prepareTrash: 'duplicates',
          history: 'rename',
          execute: 'owner',
        },
      );
      firewall = await createService(['firewall'], 'firewall');
      repair = await createService(['repair'], 'repair');
      driverInspector = await createService(['drivers'], 'drivers');
      drives = await createService(['drives'], 'drives');
      const mediaService = group(
        {
          mp3: await createService(['mp3'], 'media'),
          mp4: await createService(['mp4'], 'media'),
          gif: await createService(['gif'], 'media'),
        },
        {},
      );
      const networkService = group(
        {
          network: await createService(['network'], 'network'),
          speed: await createService(['speed'], 'network'),
        },
        {},
      );
      server = await startServer({
        workbench,
        toolHost,
        remoteMedia: mediaService,
        remoteNetwork: networkService,
      });
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      const area = screen.getPrimaryDisplay().workArea;
      const width = Math.min(1080, area.width - 40);
      const expandedHeight = Math.min(720, area.height - 30);
      window = new BrowserWindow({
        width,
        height: 350,
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - expandedHeight) / 2),
        minWidth: Math.min(760, width),
        minHeight: 350,
        frame: false,
        backgroundColor: '#000000',
        title: 'OMNIA',
        icon: path.join(__dirname, '../assets/app-icon.png'),
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // Shell-owned navigation.
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.on('app-command', (_event, command) => {
        if (command === 'browser-backward') void moveHistory('back');
        if (command === 'browser-forward') void moveHistory('forward');
      });
      window.webContents.on('before-input-event', (event, input) => {
        const back = input.key === 'BrowserBack' || (input.alt && input.key === 'ArrowLeft');
        const forward = input.key === 'BrowserForward' || (input.alt && input.key === 'ArrowRight');
        if (back || forward) {
          event.preventDefault();
          if (input.type === 'keyDown' && !input.isAutoRepeat)
            void moveHistory(back ? 'back' : 'forward');
        }
      });
      const broadcast = (channel, value) => {
        if (views) views.broadcast(channel, value);
        else if (window && !window.isDestroyed()) window.webContents.send(channel, value);
      };
      const notify = (text) => {
        if (!window.isDestroyed()) window.webContents.send('omnia:notice', text);
      };
      const originalBusy = server.isBusy;
      server.isBusy = () =>
        originalBusy() ||
        sshKeys.isBusy() ||
        fileTools.isBusy() ||
        drives.isBusy() ||
        driverInspector.isBusy() ||
        firewall.isMutating() ||
        repair.isBusy() ||
        admin.status().busy;
      window.on('close', (event) => {
        if (
          sshKeys.isBusy() ||
          fileTools.isBusy() ||
          driverInspector.isBusy() ||
          firewall.isMutating() ||
          repair.isBusy() ||
          admin.status().busy
        ) {
          event.preventDefault();
          notify('Wait for the system operation to finish before closing OMNIA.');
          return;
        }
        views?.close();
      });
      if (process.platform === 'win32')
        window.hookWindowMessage(0x0219, () => {
          clearTimeout(deviceTimer);
          deviceTimer = setTimeout(() => {
            void Promise.resolve()
              .then(() => drives.refresh())
              .catch(() => {});
          }, 700);
        });
      const handle = (channel, handler) =>
        ipcMain.handle(channel, (event, ...args) => {
          if (!trusted(event)) throw Error('Untrusted tool request.');
          const id = event.sender === window.webContents ? 'home' : views.identify(event.sender);
          require('./access.cjs').ipcAccess(
            id,
            channel.slice('omnia:'.length),
            args[0],
            args[1],
            (key) => (channel === 'omnia:files' ? workbench.ownerOf(key) : fileTools.ownerOf(key)),
          );
          return handler(event, ...args);
        });
      const trusted = (event) => {
        try {
          const url = new URL(event.senderFrame?.url);
          return (
            (event.sender === window.webContents || !!views?.identify(event.sender)) &&
            event.senderFrame === event.sender.mainFrame &&
            url.origin === server.origin &&
            (event.sender === window.webContents
              ? ['/', '/launcher.html'].includes(url.pathname)
              : url.pathname === '/' + views.identify(event.sender))
          );
        } catch {
          return false;
        }
      };
      validation = require('./validation.cjs').createValidation(
        {
          root: path.dirname(process.execPath),
          executable: process.execPath,
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          trust: require('../assets/release-trust.json'),
          packaged: app.isPackaged,
        },
        (state) => {
          if (!window.isDestroyed()) window.webContents.send('omnia:validation-state', state);
        },
      );
      handle('omnia:validation', (event) => {
        if (!trusted(event)) throw Error('Untrusted validation request.');
        return validation.status();
      });
      let recoveries = 0;
      const navigation = require('./navigation.cjs').createNavigation(async (tool) => {
        if (!(tool === 'home' || registry.some((entry) => entry.id === tool))) return false;
        if (toolHost.has(tool))
          throw Error('This tool is unavailable. Reset it from the directory.');
        return views.open(tool);
      });
      views = require('./tool-views.cjs').createToolViews({
        window,
        server,
        registry,
        motionEnabled: () => settings.get().enabled && settings.get().transitions,
        onFault: (id, reason) => toolHost.quarantine([id], reason),
        onHome: () => navigation.reset(),
        onHistory: (direction) => moveHistory(direction),
      });
      let settingsTarget;
      handle('omnia:settings', async (_event, action, data) => {
        if (action === 'get') return settings.get();
        if (action === 'update') {
          try {
            return await settings.update(data);
          } catch {
            throw Error('Could not save animation settings. Try again.');
          }
        }
        if (action === 'open') {
          if (views.covered()) {
            window.webContents.send('omnia:settings-open');
            return true;
          }
          const backdrop = await views.backdrop();
          if (!backdrop) return false;
          settingsTarget = backdrop.id;
          window.webContents.send('omnia:settings-open', { image: backdrop.image });
          return true;
        }
        if (action === 'cover') {
          const id = settingsTarget;
          settingsTarget = null;
          return views.cover(id);
        }
        if (action === 'uncover') {
          views.uncover();
          return true;
        }
        throw Error('Unsupported settings operation.');
      });
      function moveHistory(direction) {
        if (views.covered()) {
          window.webContents.send('omnia:settings-dismiss');
          return Promise.resolve(false);
        }
        return navigation.go(direction).catch((error) => {
          notify(error.message);
          return false;
        });
      }
      function openTool(tool = 'mp3') {
        return navigation.open(tool);
      }
      handle('omnia:open', (_event, tool) => openTool(tool));
      handle('omnia:history', (_event, direction) => moveHistory(direction));
      ipcMain.on('omnia:history', (event, direction) => {
        if (trusted(event) && ['back', 'forward'].includes(direction)) void moveHistory(direction);
      });
      ipcMain.on('omnia:motion-frame', (event, id, progress) => {
        if (trusted(event)) views.frame(event.sender, id, progress);
      });
      handle('omnia:tool-info', (event) => ({
        tool: registry.find((tool) => tool.id === views.identify(event.sender)),
        platform: process.platform,
      }));
      handle('omnia:tool-view', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted view request.');
        if (action === 'discard' && event.sender === window.webContents) {
          views.discard(data.id);
          return true;
        }
        throw Error('Unsupported view request.');
      });
      ipcMain.on('omnia:tool-heartbeat', (event, dirty) => views.heartbeat(event.sender, dirty));
      window.webContents.on('will-frame-navigate', (event) => {
        const url = event.url;
        if (url && !url.startsWith(server.origin + '/')) event.preventDefault();
      });
      handle('omnia:network-settings', async (event) => {
        if (trusted(event) && process.platform === 'win32') {
          await shell.openExternal('ms-settings:network-status');
          return true;
        }
        return false;
      });
      handle('omnia:admin', async (event, action) => {
        if (!trusted(event)) throw Error('Untrusted administrator request.');
        if (action === 'status') return admin.status();
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'enable') return admin.enable();
        if (action === 'disable') return admin.disable();
        throw Error('Unsupported administrator request.');
      });
      handle('omnia:drives', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted drive request.');
        if (action === 'status') return drives.view();
        if (action === 'refresh') return drives.refresh();
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'prepare') return drives.prepare(data.action, data);
        if (action === 'execute') return drives.execute(data.token, data.phrase);
        if (action === 'configure') return drives.configure(data.id, data.action);
        throw Error('Unsupported drive request.');
      });
      handle('omnia:copy', (event, text) => {
        if (trusted(event) && typeof text === 'string' && text.length <= 200000) {
          clipboard.writeText(text);
          return true;
        }
        return false;
      });
      handle('omnia:drivers', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted driver request.');
        if (action === 'status') return driverInspector.status();
        if (action === 'documentation') {
          const url = {
            syntax:
              'https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax',
            removal:
              'https://learn.microsoft.com/en-us/windows-hardware/drivers/install/using-device-manager-to-uninstall-devices-and-driver-packages',
            boot: 'https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/stop-error-7b-or-inaccessible-boot-device-troubleshooting',
          }[data.id];
          if (!url || typeof url !== 'string') throw Error('Unknown documentation page.');
          await shell.openExternal(url);
          return true;
        }
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'scan') return driverInspector.refresh();
        if (action === 'prepare') return driverInspector.prepare(data.action, data.inf);
        if (action === 'execute')
          return driverInspector.execute(data.token, data.phrase, data.acknowledgedRisk);
        if (action === 'reveal') {
          const file = await driverInspector.location(data.kind, data.id);
          await require('node:fs/promises').stat(file);
          if (data.kind === 'backup') {
            const error = await shell.openPath(file);
            if (error) throw Error(error);
          } else shell.showItemInFolder(file);
          return true;
        }
        throw Error('Unsupported driver request.');
      });
      handle('omnia:tool-health', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted tool request.');
        if (action === 'status') return toolHost.status();
        if (!registry.some((tool) => tool.id === data.id)) throw Error('Unknown tool.');
        if (action === 'fault') {
          if (views.identify(event.sender) && views.identify(event.sender) !== data.id)
            throw Error('Tool identity mismatch.');
          toolHost.quarantine([data.id]);
          views.fail(data.id, 'The tool interface stopped unexpectedly.');
          return toolHost.status();
        }
        if (action === 'reset') {
          if (admin.status().busy)
            throw Error('Finish or cancel the active operation before resetting a tool.');
          views.discard(data.id);
          return toolHost.reset(data.id);
        }
        throw Error('Unsupported tool request.');
      });
      window.webContents.on('render-process-gone', () => {
        if (quitting || window.isDestroyed()) return;
        views.home();
        navigation.reset();
        if (++recoveries <= 3)
          void window
            .loadURL(server.origin + '/launcher.html?return=1')
            .catch(() => notify('The interface could not reload. Restart OMNIA.'));
        else
          dialog.showErrorBox(
            'OMNIA interface stopped',
            'The interface failed repeatedly. Restart OMNIA after any active operation finishes.',
          );
      });
      handle('omnia:ssh', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted key request.');
        if (action === 'status') return sshKeys.status();
        if (action === 'cancel') return sshKeys.cancel();
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'refresh') return sshKeys.refresh();
        if (action === 'folder') {
          const chosen = await dialog.showOpenDialog(window, {
            title: 'Choose where to save the key folder',
            properties: ['openDirectory', 'createDirectory'],
          });
          return chosen.canceled ? sshKeys.status() : sshKeys.selectFolder(chosen.filePaths[0]);
        }
        if (action === 'choose') {
          const chosen = await dialog.showOpenDialog(window, {
            title: 'Choose one SSH key',
            properties: ['openFile'],
          });
          return chosen.canceled ? sshKeys.status() : sshKeys.selectFile(chosen.filePaths[0]);
        }
        if (action === 'drop') {
          if (!Array.isArray(data.paths) || data.paths.length !== 1)
            throw Error('Drop one SSH key.');
          return sshKeys.selectFile(data.paths[0]);
        }
        if (action === 'generate') return sshKeys.generate(data);
        if (action === 'inspect') return sshKeys.inspect(data.passphrase);
        if (action === 'change') return sshKeys.change(data);
        if (action === 'clear') return sshKeys.clear();
        if (action === 'copy') {
          const result = (await sshKeys.status()).result;
          if (!result || !['public', 'fingerprint'].includes(data.kind))
            throw Error('Generate or inspect a key first.');
          clipboard.writeText(data.kind === 'public' ? result.line : result.fingerprint);
          return true;
        }
        if (action === 'reveal') {
          const file = (await sshKeys.status()).result?.privatePath;
          if (!file) throw Error('No saved key pair.');
          shell.showItemInFolder(file);
          return true;
        }
        if (action === 'export') {
          const value = await sshKeys.exportPublic(data.format);
          const chosen = await dialog.showSaveDialog(window, {
            title: 'Save public key',
            defaultPath:
              data.format === 'openssh'
                ? 'key.pub'
                : data.format === 'RFC4716'
                  ? 'public.ssh2'
                  : 'public.pem',
          });
          if (chosen.canceled) return false;
          try {
            await require('node:fs/promises').writeFile(chosen.filePath, value, { flag: 'wx' });
          } catch (e) {
            throw Error(
              e.code === 'EEXIST'
                ? 'That file already exists. Choose another filename.'
                : 'The public key could not be saved.',
            );
          }
          return true;
        }
        throw Error('Unsupported key request.');
      });
      handle('omnia:file-tools', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted file request.');
        const tool = data.tool;
        if (action === 'status') return fileTools.status(tool);
        if (action === 'roots') return fileTools.roots(tool, data.part);
        if (action === 'folders') return fileTools.folders(tool, data.path, data.offset);
        if (action === 'query') return fileTools.query(tool, data);
        if (action === 'cancel') return fileTools.cancel(tool);
        if (action === 'history') return fileTools.history();
        if (action === 'reveal') {
          shell.showItemInFolder(await fileTools.location(tool, data.id));
          return true;
        }
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'clear') return fileTools.clear(tool);
        if (action === 'select') return fileTools.select(tool, data.paths);
        if (action === 'remove') return fileTools.remove(tool, data.path);
        if (action === 'drop') return fileTools.select(tool, data.paths);
        if (action === 'choose') {
          await fileTools.status(tool);
          const result = await dialog.showOpenDialog(window, {
            title: data.folder ? 'Choose folders' : 'Choose files',
            properties: [data.folder ? 'openDirectory' : 'openFile', 'multiSelections'],
          });
          return result.canceled
            ? fileTools.status(tool)
            : fileTools.select(tool, result.filePaths);
        }
        if (action === 'start') return fileTools.start(tool, data.options);
        if (action === 'rename') return fileTools.prepareRename(data.rules);
        if (action === 'undo') return fileTools.prepareUndo(data.id);
        if (action === 'trash') return trashReview.remember(await fileTools.prepareTrash(data.ids));
        if (action === 'execute')
          return tool === 'duplicates'
            ? trashReview.execute(data.token, () => fileTools.execute(data.token))
            : fileTools.execute(data.token);
        throw Error('Unsupported file operation.');
      });
      handle('omnia:diskspace', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted disk request.');
        if (action === 'status') return diskSpace.status();
        if (action === 'refresh') return diskSpace.refresh();
        if (action === 'cancel') return diskSpace.cancel();
        if (action === 'clear') {
          await diskSpace.clear();
          return diskSpace.status();
        }
        if (action === 'query') return diskSpace.query(data.id, data.offset, data.sort);
        if (action === 'reveal') {
          const file = await diskSpace.query(data.id, 0, 'size', true);
          shell.showItemInFolder(file);
          return true;
        }
        if (action === 'management' && process.platform === 'win32') {
          require('node:child_process')
            .spawn(
              path.join(process.env.SystemRoot, 'System32/mmc.exe'),
              [path.join(process.env.SystemRoot, 'System32/diskmgmt.msc')],
              { detached: true, stdio: 'ignore' },
            )
            .on('error', (e) => notify(e.message))
            .unref();
          return true;
        }
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'volume') return diskSpace.startVolume(data.id);
        if (action === 'folder') {
          const result = await dialog.showOpenDialog(window, {
            title: 'Choose a folder to analyze',
            properties: ['openDirectory'],
          });
          return result.canceled ? diskSpace.status() : diskSpace.start(result.filePaths[0]);
        }
        throw Error('Unsupported disk request.');
      });
      handle('omnia:firewall', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted firewall request.');
        if (action === 'status') return firewall.status();
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'refresh') return firewall.refresh();
        if (action === 'detail') return firewall.detail(data.name);
        if (action === 'prepare') return firewall.prepare(data.operation, data);
        if (action === 'execute') return firewall.execute(data.token);
        if (action === 'program') {
          const result = await dialog.showOpenDialog(window, {
            title: 'Choose an application',
            properties: ['openFile'],
            filters: [{ name: 'Windows application', extensions: ['exe'] }],
          });
          return result.canceled ? null : result.filePaths[0];
        }
        throw Error('Unsupported firewall request.');
      });
      handle('omnia:repair', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted repair request.');
        if (action === 'status') return repair.status();
        if (action === 'volumes') return repair.volumes();
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'prepare') return repair.prepare(data.task, data.volumeId);
        if (action === 'execute') return repair.execute(data.token);
        throw Error('Unsupported repair request.');
      });
      handle('omnia:files', async (event, action, data = {}) => {
        if (!trusted(event)) throw Error('Untrusted file request.');
        if (action === 'status') return workbench.status(data.id);
        if (action === 'cancel') return workbench.cancel(data.id);
        if (admin.status().busy) throw Error('Wait for the active system operation to finish.');
        if (action === 'drop') return workbench.select(data.tool, data.paths);
        if (action === 'clear') return workbench.clear(data.tool);
        if (action === 'choose') {
          if (!['images', 'metadata', 'inspector'].includes(data.tool))
            throw Error('Unknown file tool.');
          const result = await dialog.showOpenDialog(window, {
            title: 'Choose ' + (data.tool === 'inspector' ? 'a file' : 'images'),
            properties: data.tool === 'images' ? ['openFile', 'multiSelections'] : ['openFile'],
            filters:
              data.tool === 'inspector'
                ? undefined
                : [
                    { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
                    { name: 'All files', extensions: ['*'] },
                  ],
          });
          return result.canceled ? null : workbench.select(data.tool, result.filePaths);
        }
        if (action === 'start') return workbench.start(data.tool, data.operation, data.options);
        if (action === 'save') {
          const asset = await workbench.asset(data.id);
          if (!asset || asset.role !== 'output') throw Error('This result expired. Convert again.');
          const result = await dialog.showSaveDialog(window, {
            defaultPath: asset.name,
            buttonLabel: 'Save copy',
          });
          return result.canceled ? null : workbench.save(data.id, result.filePath);
        }
        if (action === 'save-batch') {
          const result = await dialog.showOpenDialog(window, {
            title: 'Save image copies',
            properties: ['openDirectory', 'createDirectory'],
          });
          return result.canceled ? null : workbench.saveBatch(data.ids, result.filePaths[0]);
        }
        if (action === 'reveal') {
          const source = await workbench.source(data.tool, data.id);
          if (!source) throw Error('Select this file again.');
          shell.showItemInFolder(source.path);
          return true;
        }
        throw Error('Unsupported file request.');
      });
      const updates = require('./updates.cjs').createUpdates({
        app,
        window,
        isBusy: server.isBusy,
        recovery: require('./bootstrap.cjs').get(),
      });
      handle('omnia:updates', async (event, action) => {
        if (trusted(event) && ['status', 'check', 'download', 'install'].includes(action))
          return updates(action);
      });
      ipcMain.on('omnia:minimize', (event) => {
        if (trusted(event) && event.sender === window.webContents) window.minimize();
      });
      ipcMain.on('omnia:close', (event) => {
        if (trusted(event) && event.sender === window.webContents) window.close();
      });
      let expanded = false,
        expansion;
      const introFrames = process.env.OMNIA_SMOKE === '1' ? [] : null;
      handle('omnia:expand', (event, reduced) => {
        if (!trusted(event) || expanded) return;
        expanded = true;
        const bounds = window.getBounds();
        const work = screen.getDisplayMatching(bounds).workArea;
        const target = Math.max(bounds.height, Math.min(720, work.height - 30));
        const y = Math.max(work.y, Math.min(bounds.y, work.y + work.height - target));
        if (y !== bounds.y) window.setPosition(bounds.x, y);
        expansion = { start: bounds.height, target, progress: 0, lastHeight: bounds.height };
        return {
          duration: reduced || !settings.get().enabled || !settings.get().transitions ? 0 : 850,
        };
      });
      ipcMain.on('omnia:expand-frame', (event, progress) => {
        if (
          !trusted(event) ||
          event.sender !== window.webContents ||
          !expansion ||
          !Number.isFinite(progress)
        )
          return;
        const t = Math.max(expansion.progress, Math.min(1, Math.max(0, progress)));
        expansion.progress = t;
        const ease = 1 - (1 - t) ** 3;
        const height = Math.round(expansion.start + (expansion.target - expansion.start) * ease);
        // One resize per frame.
        if (height !== expansion.lastHeight) {
          window.setBounds({ height });
          expansion.lastHeight = height;
        }
        if (introFrames)
          introFrames.push({ at: performance.now(), height, y: window.getBounds().y });
        if (t === 1) {
          expansion = null;
          window.webContents.send('omnia:expanded');
          void require('./bootstrap.cjs')
            .healthy()
            ?.catch(() => {});
        }
      });
      const reveal = () => {
        window.show();
        window.restore();
        window.moveTop();
        window.focus();
      };
      let visibleMs;
      if (process.env.OMNIA_SMOKE === '1')
        window.once('show', () => {
          visibleMs = Math.round(process.uptime() * 1000);
        });
      window.once('ready-to-show', reveal);
      await window.loadURL(server.desktopUrl);
      validationTimer = setTimeout(() => validation.start(), 3000);
      deviceTimer = setTimeout(() => {
        void Promise.resolve()
          .then(() => drives.refresh())
          .catch(() => {});
      }, 3500);
      if (!window.isVisible()) reveal();
      if (process.env.OMNIA_SMOKE === '1') {
        setTimeout(async () => {
          try {
            await require(
              process.env.OMNIA_LIFECYCLE_SMOKE ? './lifecycle-smoke.cjs' : './smoke.cjs',
            )({
              app,
              window,
              server,
              workbench,
              views,
              visibleMs,
              introFrames,
            });
          } catch (error) {
            await require('node:fs/promises')
              .writeFile(
                path.join(process.cwd(), '.qa', 'packaged-smoke-error.txt'),
                error.stack || error.message,
              )
              .catch(() => {});
          } finally {
            if (!process.env.OMNIA_LIFECYCLE_SMOKE) app.quit();
          }
        }, 4000);
      }
    })
    .catch((error) => {
      require('electron').dialog.showErrorBox('OMNIA could not start', error.message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (server && !quitting) {
      event.preventDefault();
      quitting = true;
      clearTimeout(deviceTimer);
      clearTimeout(validationTimer);
      views?.close();
      validation?.close();
      Promise.allSettled(serviceProcesses.map((service) => service.close()))
        .then(() => server.close())
        .finally(() => {
          admin?.close();
          app.quit();
        });
    }
  });
}
