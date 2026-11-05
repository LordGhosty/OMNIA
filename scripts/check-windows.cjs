const { execFileSync } = require('node:child_process'),
  path = require('node:path'),
  fs = require('node:fs');
const { windowsTarget } = require('../src/platform.cjs');
const report = {
  version: require('../package.json').version,
  checkedAt: new Date().toISOString(),
  ...windowsTarget(),
};
if (process.platform === 'win32') {
  const command =
    "$ErrorActionPreference='Stop';$os=Get-CimInstance Win32_OperatingSystem;$names=@('Get-NetAdapter','Get-DnsClientServerAddress','Clear-DnsClientCache','Register-DnsClient','Restart-NetAdapter','Get-Disk','Get-Partition','Get-Volume','Get-NetFirewallRule','Copy-NetFirewallRule','Get-CimInstance','Invoke-CimMethod','dism.exe','sfc.exe','chkdsk.exe','pnputil.exe','ssh-keygen.exe');$checks=@{};foreach($name in $names){$checks[$name]=[bool](Get-Command $name -ErrorAction SilentlyContinue)};@{caption=$os.Caption;client=($os.ProductType -eq 1);powerShell=$PSVersionTable.PSVersion.ToString();capabilities=$checks}|ConvertTo-Json -Compress";
  try {
    Object.assign(
      report,
      JSON.parse(
        execFileSync(
          path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(command, 'utf16le').toString('base64'),
          ],
          {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      ),
    );
    report.target = report.target && report.client;
  } catch {
    report.target = null;
    report.probeError = 'Windows capability inventory could not be read.';
  }
}
report.validation =
  'Capability inventory only; native application and installer tests are required separately.';
if (process.argv[2])
  fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
