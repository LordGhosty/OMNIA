const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { domainToASCII } = require('node:url');
const WIN = process.platform === 'win32';
const system = (name) =>
  WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name) : name;
const powershell = () => system('WindowsPowerShell/v1.0/powershell.exe');
const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
function target(value) {
  const text = String(value || '').trim();
  if (/[\s\x00-\x1f\x7f]/.test(text))
    throw Error('Enter a hostname or IP address, without a URL, path or command.');
  if (net.isIP(text)) return text;
  const ascii = domainToASCII(text);
  if (
    !ascii ||
    ascii.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(ascii) ||
    ascii
      .split('.')
      .some(
        (label) =>
          !label.length || label.length > 63 || label.startsWith('-') || label.endsWith('-'),
      )
  )
    throw Error('Enter a hostname or IP address, without a URL, path or command.');
  return ascii;
}
function command(executable, args, { signal, timeout = 20000, onText } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Cancelled.'));
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      failure;
    const stop = () => {
      failure = 'Cancelled.';
      child.kill();
    };
    const timer = setTimeout(() => {
      failure = 'The operation timed out.';
      child.kill();
    }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    const append = (data) => {
      const text = data.toString('utf8');
      output = (output + text).slice(-200000);
      onText?.(text);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      failure =
        error.code === 'ENOENT'
          ? 'This system command is not installed on this computer.'
          : error.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure) reject(Error(failure));
      else resolve({ output: output.trim(), code });
    });
  });
}
const ps = (script, options) =>
  command(
    powershell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-EncodedCommand',
      encoded(
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
          script,
      ),
    ],
    options,
  );
const windowsSnapshot = `
$adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue)
$addresses=@(Get-NetIPAddress -ErrorAction SilentlyContinue)
$interfaces=@(Get-NetIPInterface -ErrorAction SilentlyContinue)
$dns=@(Get-DnsClientServerAddress -ErrorAction SilentlyContinue)
$routes=@(Get-NetRoute -ErrorAction SilentlyContinue | Where-Object {$_.DestinationPrefix -in @('0.0.0.0/0','::/0')})
$rows=@(foreach($a in $adapters){
 $ip=@($addresses | Where-Object InterfaceIndex -eq $a.ifIndex)
 $v4=$interfaces | Where-Object {$_.InterfaceIndex -eq $a.ifIndex -and $_.AddressFamily -eq 2} | Select-Object -First 1
 [pscustomobject]@{name=$a.Name;index=[int]$a.ifIndex;description=$a.InterfaceDescription;status=[string]$a.Status;mac=$a.MacAddress;linkSpeed=[string]$a.LinkSpeed;mtu=$v4.NlMtu;dhcp=([string]$v4.Dhcp -eq 'Enabled');addresses=@($ip | ForEach-Object {[pscustomobject]@{address=$_.IPAddress;prefix=$_.PrefixLength;family=if($_.AddressFamily -eq 2){'IPv4'}else{'IPv6'};origin=[string]$_.PrefixOrigin}});dns=@($dns | Where-Object InterfaceIndex -eq $a.ifIndex | ForEach-Object {$_.ServerAddresses});gateways=@($routes | Where-Object InterfaceIndex -eq $a.ifIndex | ForEach-Object {$_.NextHop});metric=$v4.InterfaceMetric}
})
ConvertTo-Json -Depth 6 -Compress -InputObject $rows`;
function basicInfo() {
  const adapters = Object.entries(os.networkInterfaces())
    .filter(([, addresses]) => addresses.some((a) => !a.internal))
    .map(([name, addresses]) => ({
      name,
      status: 'Detected',
      mac: addresses[0]?.mac,
      dhcp: null,
      addresses: addresses.map((a) => ({
        address: a.address,
        prefix: Number(a.cidr?.split('/')[1]),
        family: a.family,
      })),
      dns: [],
      gateways: [],
    }));
  adapters.sort(
    (a, b) =>
      Number(b.addresses.some((ip) => ip.family === 'IPv4' && !ip.address.startsWith('169.254.'))) -
      Number(a.addresses.some((ip) => ip.family === 'IPv4' && !ip.address.startsWith('169.254.'))),
  );
  return {
    platform: process.platform,
    hostname: os.hostname(),
    adapters,
    warning: 'Loading gateway, DNS and adapter details…',
    checkedAt: new Date().toISOString(),
    actionsAvailable: false,
    preliminary: true,
  };
}
async function snapshot() {
  let adapters = [],
    warning = '';
  if (WIN) {
    try {
      const result = await ps(windowsSnapshot, { timeout: 30000 });
      if (result.code !== 0) throw Error(result.output);
      adapters = JSON.parse(result.output);
    } catch {
      warning =
        'Extended adapter details are unavailable. Showing addresses reported by the operating system.';
    }
  } else {
    try {
      const [a, r] = await Promise.all([
        command('ip', ['-j', 'address', 'show']),
        command('ip', ['-j', 'route', 'show', 'default']),
      ]);
      const routes = JSON.parse(r.output);
      adapters = JSON.parse(a.output).map((item) => ({
        name: item.ifname,
        index: item.ifindex,
        status: item.operstate,
        mac: item.address,
        mtu: item.mtu,
        linkSpeed: null,
        dhcp: null,
        addresses: (item.addr_info || []).map((ip) => ({
          address: ip.local,
          prefix: ip.prefixlen,
          family: ip.family === 'inet' ? 'IPv4' : 'IPv6',
        })),
        dns: dns.getServers(),
        gateways: routes
          .filter((route) => route.dev === item.ifname)
          .map((route) => route.gateway)
          .filter(Boolean),
      }));
    } catch {
      warning = 'Install iproute2 for gateway, route and extended adapter details.';
    }
  }
  if (!adapters.length)
    adapters = Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({
      name,
      status: addresses.some((a) => !a.internal) ? 'Up' : 'Loopback',
      mac: addresses[0]?.mac,
      addresses: addresses.map((a) => ({
        address: a.address,
        prefix: Number(a.cidr?.split('/')[1]),
        family: a.family,
        netmask: a.netmask,
      })),
      dns: dns.getServers(),
      gateways: [],
    }));
  adapters.sort(
    (a, b) =>
      Number(b.gateways?.length > 0) - Number(a.gateways?.length > 0) ||
      Number(b.status === 'Up') - Number(a.status === 'Up'),
  );
  return {
    platform: process.platform,
    hostname: os.hostname(),
    adapters,
    warning,
    checkedAt: new Date().toISOString(),
    actionsAvailable: WIN,
  };
}
const cooldowns = new Map();
function request(
  url,
  { method = 'GET', body, family, signal, onBytes, agent, lookup, timeout = 15000 } = {},
) {
  return new Promise((resolve, reject) => {
    const origin = new URL(url).origin,
      remaining = (cooldowns.get(origin) || 0) - Date.now();
    if (remaining > 0)
      return reject(
        Error(
          'This provider is cooling down. Try again in ' +
            Math.ceil(remaining / 60000) +
            ' minutes, or choose another server.',
        ),
      );
    const began = performance.now();
    let bytes = 0,
      firstByte,
      content = '';
    const req = https.request(
      url,
      {
        method,
        family,
        signal,
        agent,
        lookup,
        headers: {
          'User-Agent': 'OMNIA/0.0.2',
          'Accept-Encoding': 'identity',
          ...(body
            ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }
            : {}),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          let message = 'The measurement service returned HTTP ' + res.statusCode + '.';
          if (res.statusCode === 429) {
            const value = res.headers['retry-after'],
              delay = /^\d+$/.test(value || '')
                ? Number(value) * 1000
                : Math.max(60000, Date.parse(value) - Date.now() || 60000);
            cooldowns.set(origin, Date.now() + delay);
            message =
              'This provider is rate limiting requests. Wait ' +
              Math.ceil(delay / 60000) +
              ' minutes or choose another server. No complete speed result is available.';
          }
          reject(Error(message));
          return;
        }
        res.on('data', (chunk) => {
          firstByte ??= performance.now() - began;
          bytes += chunk.length;
          if (content.length < 16000) content += chunk.toString();
          onBytes?.(chunk.length);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ bytes, ms: performance.now() - began, firstByte, content }));
      },
    );
    const timer = setTimeout(
      () => req.destroy(Error('The measurement service timed out.')),
      timeout,
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
async function publicIP(signal) {
  const rows = await Promise.allSettled(
    [4, 6].map(async (family) => {
      const response = await request('https://www.cloudflare.com/cdn-cgi/trace', {
        family,
        signal,
        timeout: 10000,
      });
      const fields = Object.fromEntries(
        response.content
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      );
      if (net.isIP(fields.ip) !== family) throw Error('No IPv' + family + ' response.');
      return {
        family: 'IPv' + family,
        address: fields.ip,
        edge: fields.colo || null,
        country: fields.loc || null,
      };
    }),
  );
  return {
    provider: 'Cloudflare',
    checkedAt: new Date().toISOString(),
    addresses: rows.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    unavailable: rows
      .map((r, i) => (r.status === 'rejected' ? 'IPv' + [4, 6][i] : null))
      .filter(Boolean),
  };
}
function subnet(value) {
  const [address, prefixText, ...rest] = String(value || '').split('/');
  const prefix = Number(prefixText);
  if (
    rest.length ||
    net.isIP(address) !== 4 ||
    prefixText === undefined ||
    !/^\d+$/.test(prefixText) ||
    prefix < 0 ||
    prefix > 32
  )
    throw Error('Enter IPv4/CIDR, for example 192.168.1.25/24.');
  const ip = address.split('.').reduce((v, n) => (v * 256 + Number(n)) >>> 0, 0),
    mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0,
    broadcast = (network | (~mask >>> 0)) >>> 0,
    format = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
  const total = 2 ** (32 - prefix),
    usable = prefix >= 31 ? total : total - 2;
  return {
    address,
    prefix,
    mask: format(mask),
    network: format(network),
    broadcast: prefix < 31 ? format(broadcast) : 'Not used for /31 or /32',
    first: format(network + (prefix < 31 ? 1 : 0)),
    last: format(broadcast - (prefix < 31 ? 1 : 0)),
    total,
    usable,
  };
}
function diagnosticPlan(kind, input = {}) {
  if (['ping', 'trace', 'pathping'].includes(kind)) {
    const host = target(input.target);
    const count = Number(input.count ?? 4),
      hops = Number(input.hops ?? 12),
      family = String(input.family || 'auto');
    if (
      ![4, 10, 30, 60].includes(count) ||
      ![8, 12, 20, 30].includes(hops) ||
      !['auto', '4', '6'].includes(family)
    )
      throw Error('Choose valid diagnostic options.');
    const af = family === 'auto' ? [] : ['-' + family];
    if (kind === 'ping')
      return WIN
        ? {
            executable: system('PING.EXE'),
            args: [...af, '-n', String(count), '-w', '1500', host],
            timeout: count * 2500 + 5000,
          }
        : {
            executable: 'ping',
            args: [...af, '-n', '-c', String(count), '-W', '2', host],
            timeout: count * 3000 + 5000,
          };
    if (kind === 'pathping') {
      if (!WIN) throw Error('Pathping requires Windows.');
      return {
        executable: system('pathping.exe'),
        args: [...af, '-n', '-h', String(hops), '-q', '10', '-p', '100', '-w', '500', host],
        timeout: 90000,
      };
    }
    return WIN
      ? {
          executable: system('tracert.exe'),
          args: [...af, '-d', '-h', String(hops), '-w', '700', host],
          timeout: hops * 2500 + 5000,
        }
      : {
          executable: 'traceroute',
          args: [...af, '-n', '-m', String(hops), '-w', '1', '-q', '1', host],
          timeout: hops * 1500 + 5000,
        };
  }
  const readScripts = {
    statistics:
      'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes,ReceivedPacketErrors,OutboundPacketErrors,ReceivedDiscardedPackets,OutboundDiscardedPackets | Format-List',
    firewall:
      'Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | Format-Table -AutoSize',
  };
  if (WIN && readScripts[kind])
    return {
      executable: powershell(),
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encoded("$ProgressPreference='SilentlyContinue';" + readScripts[kind]),
      ],
      timeout: 20000,
    };
  const plans = WIN
    ? {
        routes: [system('route.exe'), ['print']],
        neighbors: [system('ARP.EXE'), ['-a']],
        connections: [system('NETSTAT.EXE'), ['-ano']],
        cache: [system('ipconfig.exe'), ['/displaydns']],
        config: [system('ipconfig.exe'), ['/all']],
        wifi: [system('netsh.exe'), ['wlan', 'show', 'interfaces']],
        proxy: [system('netsh.exe'), ['winhttp', 'show', 'proxy']],
        networks: [system('netsh.exe'), ['wlan', 'show', 'networks', 'mode=bssid']],
      }
    : {
        routes: ['ip', ['route', 'show', 'table', 'all']],
        neighbors: ['ip', ['neigh', 'show']],
        connections: ['ss', ['-tun']],
        config: ['ip', ['-details', 'address', 'show']],
      };
  if (!plans[kind]) throw Error('This diagnostic is not available on this operating system.');
  return { executable: plans[kind][0], args: plans[kind][1], timeout: 15000 };
}
async function diagnose(kind, input, signal, onText) {
  if (kind === 'dns') {
    const host = target(input.target),
      type = input.record || 'A';
    if (!['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR'].includes(type))
      throw Error('Choose a supported DNS record type.');
    const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
    if (input.dnsServer) {
      if (!net.isIP(input.dnsServer)) throw Error('DNS server must be an IPv4 or IPv6 address.');
      resolver.setServers([input.dnsServer]);
    }
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      return {
        host,
        type,
        records: type === 'PTR' ? await resolver.reverse(host) : await resolver.resolve(host, type),
      };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  if (kind === 'tls') {
    const host = target(input.target),
      port = Number(input.port || 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error('Choose a valid TLS port.');
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true,
      });
      const abort = () => socket.destroy(Error('Cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      socket.setTimeout(8000, () => socket.destroy(Error('TLS connection timed out.')));
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        resolve({
          host,
          port,
          verified: socket.authorized,
          protocol: socket.getProtocol(),
          cipher: socket.getCipher().name,
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.valid_from,
          validUntil: cert.valid_to,
          daysRemaining: Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400000),
          names: cert.subjectaltname,
        });
        socket.destroy();
      });
      socket.once('error', reject);
      socket.once('close', () => signal.removeEventListener('abort', abort));
    });
  }
  if (kind === 'port') {
    const host = target(input.target),
      port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error('Choose a port from 1 to 65535.');
    return new Promise((resolve, reject) => {
      const began = performance.now(),
        socket = net.connect({ host, port });
      const abort = () => socket.destroy(Error('Cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      socket.setTimeout(5000, () => socket.destroy(Error('Connection timed out.')));
      socket.once('connect', () => {
        resolve({ host, port, reachable: true, ms: Math.round(performance.now() - began) });
        socket.destroy();
      });
      socket.once('error', (e) => reject(Error(e.message)));
      socket.once('close', () => signal.removeEventListener('abort', abort));
    });
  }
  const plan = diagnosticPlan(kind, input),
    result = await command(plan.executable, plan.args, { signal, timeout: plan.timeout, onText });
  return { exitCode: result.code, output: result.output };
}
const actionInfo = {
  'restart-adapter': {
    adapter: true,
    title: 'Restart adapter',
    description:
      'Disables and re-enables the selected adapter. Its connection will be interrupted, including any remote session using it.',
  },
  'dns-cloudflare': {
    adapter: true,
    title: 'Use Cloudflare DNS',
    description:
      'Sets this adapter’s IPv4 DNS servers to 1.1.1.1 and 1.0.0.1. This persists and replaces its current IPv4 DNS configuration. Cloudflare will receive its DNS queries.',
  },
  'dns-google': {
    adapter: true,
    title: 'Use Google DNS',
    description:
      'Sets this adapter’s IPv4 DNS servers to 8.8.8.8 and 8.8.4.4. This persists and replaces its current IPv4 DNS configuration. Google will receive its DNS queries.',
  },
  'dns-auto': {
    adapter: true,
    title: 'Use automatic DNS',
    description:
      'Resets this adapter’s IPv4 DNS servers to those supplied automatically by the network. This removes custom IPv4 DNS servers; it does not restore an earlier custom configuration.',
  },
  'flush-dns': {
    title: 'Flush DNS cache',
    description:
      'Clears cached DNS answers on this computer. Windows will look them up again as needed.',
  },
  'renew-dhcp': {
    adapter: true,
    title: 'Renew local IP lease',
    description:
      'Requests a fresh IPv4 DHCP lease for the selected adapter. Connectivity may pause. The router may assign the same IP; this does not change your public IP.',
  },
  'register-dns': {
    title: 'Register DNS again',
    description:
      'Asks Windows to refresh this computer’s DNS registration with its configured DNS service.',
  },
};
function actionScript(action, adapter, pipeName) {
  if (!actionInfo[action]) throw Error('Unknown network action.');
  if (!/^omnia-network-[a-f0-9-]{36}$/.test(pipeName))
    throw Error('Invalid action result channel.');
  const index = Number(adapter?.index);
  if (actionInfo[action].adapter && (!Number.isInteger(index) || index < 1))
    throw Error('Select a DHCP adapter.');
  let operation =
    action === 'flush-dns'
      ? `Clear-DnsClientCache; 'DNS cache cleared.'`
      : action === 'register-dns'
        ? `& "$env:SystemRoot\\System32\\ipconfig.exe" /registerdns; if($LASTEXITCODE -ne 0){throw 'DNS registration failed.'}`
        : `$adapter=Get-NetAdapter -IncludeHidden | Where-Object ifIndex -eq ${index} | Select-Object -First 1
if(!$adapter){throw 'The selected adapter is no longer available.'}
$ip=Get-NetIPInterface -InterfaceIndex ${index} -AddressFamily IPv4
if($ip.Dhcp -ne 'Enabled'){throw 'The selected adapter does not use DHCP.'}
if($adapter.Name -match '[*?]'){throw 'This adapter name cannot be passed safely to ipconfig.'}
& "$env:SystemRoot\\System32\\ipconfig.exe" /renew $adapter.Name
if($LASTEXITCODE -ne 0){throw 'DHCP renewal failed.'}`;
  if (action === 'restart-adapter')
    operation = `$a=Get-NetAdapter -IncludeHidden | Where-Object ifIndex -eq ${index} | Select-Object -First 1;if(!$a){throw 'Adapter no longer exists.'};$a | Restart-NetAdapter -Confirm:$false;'Adapter restarted.'`;
  if (action.startsWith('dns-')) {
    const parameters =
      action === 'dns-auto'
        ? '-ResetServerAddresses'
        : action === 'dns-cloudflare'
          ? "-ServerAddresses @('1.1.1.1','1.0.0.1')"
          : "-ServerAddresses @('8.8.8.8','8.8.4.4')";
    operation = `$dns=Get-DnsClientServerAddress -InterfaceIndex ${index} -AddressFamily IPv4;if(!$dns){throw 'IPv4 adapter no longer exists.'};$dns | Set-DnsClientServerAddress ${parameters};'IPv4 DNS settings updated.'`;
  }
  return `$ErrorActionPreference='Stop';try{$output=& {${operation}} | Out-String;$result=@{ok=$true;output=$output}}catch{$result=@{ok=$false;error=$_.Exception.Message}};$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',${psQuote(pipeName)},[IO.Pipes.PipeDirection]::Out);try{$pipe.Connect(10000);$writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false));$writer.Write(($result|ConvertTo-Json -Compress));$writer.Flush()}finally{$pipe.Dispose()}`;
}
async function performAction(action, adapter) {
  if (!WIN) throw Error('These Windows actions are unavailable on this operating system.');
  const pipeName = 'omnia-network-' + crypto.randomUUID();
  let reply;
  const sockets = new Set();
  const receiver = net.createServer((socket) => {
    sockets.add(socket);
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.length > 32768) socket.destroy();
    });
    socket.on('end', () => {
      try {
        reply = JSON.parse(text);
      } catch {}
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen('\\\\.\\pipe\\' + pipeName, resolve);
  });
  try {
    const script = actionScript(action, adapter, pipeName);
    const launch = `try{$p=Start-Process -FilePath ${psQuote(powershell())} -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded(script)}') -Verb RunAs -WindowStyle Hidden -PassThru -Wait;exit $p.ExitCode}catch{Write-Output $_.Exception.Message;exit 1}`;
    const result = await ps(launch, { timeout: 180000 });
    if (result.code !== 0)
      throw Error('Administrator permission was declined or the action could not start.');
    if (!reply)
      throw Error(
        'Windows did not report the action result. Refresh connection details before trying again.',
      );
    return reply;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => receiver.close(resolve));
  }
}
const speedTest = (job, signal, options = {}) =>
  require('./speed.cjs').measure(job, signal, options.transport || request, options);
/** Serializes diagnostics and confirmed adapter changes; injectable providers support fixtures. */
function createNetworkService({
  platform = process.platform,
  snapshotFn = snapshot,
  diagnoseFn = diagnose,
  actionFn = performAction,
  publicFn = publicIP,
  speedFn = speedTest,
} = {}) {
  let current = null,
    cache = null,
    reading = null;
  const approvals = new Map();
  const info = async (refresh = false) => {
    if (!refresh && cache && Date.now() - cache.at < 5000) return cache.value;
    if (reading) return reading;
    reading = snapshotFn()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => (reading = null));
    return reading;
  };
  const start = (kind, input = {}) => {
    if (current?.pending)
      throw Error('A network operation is already running. Finish or cancel it first.');
    if (
      ![
        'public',
        'speed',
        'ping',
        'trace',
        'dns',
        'port',
        'routes',
        'neighbors',
        'connections',
        'cache',
        'config',
        'wifi',
        'pathping',
        'tls',
        'statistics',
        'firewall',
        'proxy',
        'networks',
      ].includes(kind)
    )
      throw Error('Unknown network operation.');
    if (['ping', 'trace', 'pathping', 'dns', 'port', 'tls'].includes(kind)) target(input.target);
    const job = {
      id: crypto.randomUUID(),
      kind,
      state: 'running',
      phase: 'Starting',
      progress: 0,
      output: '',
      pending: true,
      controller: new AbortController(),
      startedAt: new Date().toISOString(),
    };
    current = job;
    job.task = (async () => {
      try {
        job.result =
          kind === 'public'
            ? await publicFn(job.controller.signal)
            : kind === 'speed'
              ? await speedFn(job, job.controller.signal, {
                  mode: input.mode,
                  provider: input.provider,
                })
              : await diagnoseFn(kind, input, job.controller.signal, (text) => {
                  job.output = (job.output + text).slice(-200000);
                });
        if (job.state === 'running') {
          job.state = 'done';
          job.progress = 100;
        }
      } catch (e) {
        if (job.state === 'running') {
          job.state = 'error';
          job.error = e.message;
        }
      } finally {
        job.pending = false;
      }
    })();
    return view();
  };
  const view = () =>
    current
      ? Object.fromEntries(
          Object.entries(current).filter(([key]) => !['controller', 'task'].includes(key)),
        )
      : null;
  return {
    info,
    quick: basicInfo,
    start,
    view,
    cancel() {
      if (current?.state === 'running') {
        if (current.kind === 'action') throw Error('An approved Windows action must finish.');
        current.state = 'cancelled';
        current.controller.abort();
      }
    },
    isBusy: () => !!current?.pending,
    async prepare(action, index) {
      if (!actionInfo[action]) throw Error('Unknown network action.');
      const data = actionInfo[action].adapter
        ? await info(true)
        : { actionsAvailable: platform === 'win32' };
      if (!data.actionsAvailable) throw Error('These actions require Windows.');
      const adapter = actionInfo[action].adapter
        ? data.adapters.find((a) => a.index === Number(index))
        : null;
      if (actionInfo[action].adapter && !adapter) throw Error('Select an existing adapter.');
      if (action === 'renew-dhcp' && !adapter?.dhcp)
        throw Error('Select an adapter configured for DHCP.');
      for (const [id, plan] of approvals) if (plan.expires < Date.now()) approvals.delete(id);
      if (approvals.size > 20) approvals.clear();
      const id = crypto.randomUUID(),
        plan = { action, adapter, expires: Date.now() + 60000 };
      approvals.set(id, plan);
      return {
        id,
        ...actionInfo[action],
        adapter: adapter?.name || null,
        administrator: true,
        currentDNS: adapter?.dns || [],
      };
    },
    execute(id) {
      const plan = approvals.get(id);
      approvals.delete(id);
      if (!plan || plan.expires < Date.now())
        throw Error('The confirmation expired. Choose the action again.');
      if (current?.pending) throw Error('Finish the current network operation first.');
      const job = {
        id: crypto.randomUUID(),
        kind: 'action',
        state: 'running',
        phase: 'Waiting for Windows permission',
        progress: 0,
        pending: true,
        controller: new AbortController(),
      };
      current = job;
      job.task = (async () => {
        try {
          const result = await actionFn(plan.action, plan.adapter);
          if (!result.ok) throw Error(result.error);
          job.result = result;
          job.state = 'done';
          cache = null;
        } catch (e) {
          job.state = 'error';
          job.error = e.message;
        } finally {
          job.pending = false;
        }
      })();
      return view();
    },
    async close() {
      if (current?.state === 'running' && current.kind !== 'action') {
        current.state = 'cancelled';
        current.controller.abort();
      }
      await current?.task;
    },
  };
}
module.exports = {
  createNetworkService,
  snapshot,
  target,
  subnet,
  diagnosticPlan,
  actionScript,
  speedTest,
  publicIP,
  performAction,
};
