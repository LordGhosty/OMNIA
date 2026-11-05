const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
if (process.platform === 'win32') {
  const root = path.join(__dirname, '..'),
    source = path.join(root, 'src/ssh-askpass.cs'),
    directory = path.join(root, 'vendor/win32'),
    output = path.join(directory, 'omnia-askpass.exe');
  fs.mkdirSync(directory, { recursive: true });
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/out:' + output, source], {
    windowsHide: true,
    stdio: 'pipe',
  });
  console.log('Built SSH passphrase helper.');
}
