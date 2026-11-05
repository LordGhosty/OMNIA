const { spawn } = require('node:child_process');
process.send?.('ready');
process.on('message', (message) => {
  if (message === 'allocate') {
    try {
      global.allocation = Buffer.alloc(384 * 1024 * 1024, 1);
      process.send('allocated');
    } catch {
      process.send('denied');
    }
  }
  if (message === 'spawn') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    process.send(child.pid);
  }
});
setInterval(() => {}, 1000);
