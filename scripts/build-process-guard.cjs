const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
if (process.platform === 'win32') {
  const root = path.join(__dirname, '..'),
    directory = path.join(root, 'vendor/win32');
  fs.mkdirSync(directory, { recursive: true });
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/optimize+',
      '/out:' + path.join(directory, 'omnia-process-guard.exe'),
      path.join(root, 'src/process-guard.cs'),
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  console.log('Built process guard.');
}
