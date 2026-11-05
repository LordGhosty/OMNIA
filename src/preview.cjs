const { startServer } = require('./server.cjs');
startServer().then((server) => {
  console.log('OMNIA preview: ' + server.url);
  console.log('Launcher preview: ' + server.desktopUrl);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      await server.close();
      process.exit();
    });
});
