const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform === 'win32') {
  const root = path.join(__dirname, '..'),
    directory = path.join(root, 'vendor/win32');
  fs.mkdirSync(directory, { recursive: true });
  const pins = require('../assets/release-trust.json').windowsCertificateSha256 || [];
  if (pins.some((pin) => !/^[a-f0-9]{64}$/i.test(pin)))
    throw Error('Invalid publisher certificate pin.');
  const source = path.join(directory, 'publisher-build.cs');
  fs.writeFileSync(
    source,
    fs
      .readFileSync(path.join(root, 'src/publisher.cs'), 'utf8')
      .replace('__CERTIFICATE_PINS__', pins.map((pin) => pin.toLowerCase()).join(',')),
  );
  try {
    for (const [name, entry] of [
      ['OMNIA Recovery', 'recovery-launcher.cs'],
      ['OMNIA Validator', 'validator.cs'],
    ])
      execFileSync(
        path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        [
          '/nologo',
          '/target:winexe',
          '/optimize+',
          '/reference:System.Windows.Forms.dll',
          '/reference:System.Drawing.dll',
          '/win32icon:' + path.join(root, 'assets/icon.ico'),
          '/out:' + path.join(directory, name + '.exe'),
          path.join(root, 'src', entry),
          source,
        ],
        { windowsHide: true, stdio: 'pipe' },
      );
  } catch (error) {
    throw Error(error.stdout?.toString().trim() || error.message);
  } finally {
    fs.unlinkSync(source);
  }
  console.log('Built Windows utilities.');
}
