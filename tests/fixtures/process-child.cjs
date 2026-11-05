process.on('message', (message) => {
  if (message.type === 'init') {
    if (message.options?.hangStartup) return;
    process.send({ type: 'ready' });
  }
  if (message.type === 'call') {
    if (message.method === 'crash') process.exit(23);
    if (message.method === 'hang') while (true) {}
    if (message.method === 'echo')
      process.send({ type: 'reply', id: message.id, value: message.args[0], busy: false });
  }
  if (message.type === 'shutdown') process.exit(0);
});
setInterval(() => process.send({ type: 'beat', busy: false }), 100).unref();
