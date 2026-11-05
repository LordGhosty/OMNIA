const https = require('node:https');
const crypto = require('node:crypto');
const { catalog, publicLookup } = require('./speed-servers.cjs');
const profiles = {
  quick: { phaseMs: 5000, capBytes: 60000000 },
  standard: { phaseMs: 12000, capBytes: 300000000 },
  thorough: { phaseMs: 20000, capBytes: 600000000 },
};
const providers = {
  cloudflare: { name: 'Cloudflare', base: 'https://speed.cloudflare.com/' },
  frankfurt: {
    name: 'LibreSpeed · Frankfurt / Clouvider',
    base: 'https://fra.speedtest.clouvider.net/backend/',
  },
  newyork: {
    name: 'LibreSpeed · New York / Clouvider',
    base: 'https://nyc.speedtest.clouvider.net/backend/',
  },
};
Object.assign(providers, {
  greece: {
    name: 'LibreSpeed · Argalasti, Greece / skoultsos.eu',
    base: 'https://argalasti.skoultsos.eu/backend/',
  },
  rome: { name: 'LibreSpeed · Rome / GARR', base: 'https://st-be-rm2.infra.garr.it/' },
  amsterdam: {
    name: 'LibreSpeed · Amsterdam / Clouvider',
    base: 'https://ams.speedtest.clouvider.net/backend/',
  },
});
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
async function serverList() {
  try {
    Object.assign(providers, await catalog());
  } catch {}
  return Object.entries(providers)
    .filter(
      ([id]) =>
        id === 'cloudflare' ||
        !Object.keys(providers).some((key) => key.startsWith('ls-')) ||
        id.startsWith('ls-'),
    )
    .map(([id, p]) => ({ id, name: p.name }));
}
async function measure(
  job,
  signal,
  transport,
  {
    mode = 'standard',
    provider = 'frankfurt',
    phaseMs,
    warmupMs = 1500,
    capBytes,
    streams = 4,
    requestSpacingMs,
  } = {},
) {
  if (!profiles[mode]) throw Error('Choose a valid test duration.');
  let selection;
  if (provider === 'auto') {
    job.phase = 'Choosing server';
    job.progress = 0;
    const candidates = (await serverList()).filter((s) => s.id !== 'cloudflare').map((s) => s.id),
      checks = [];
    let cursor = 0;
    async function probe(key, repeat) {
      const probeAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const samples = [];
        for (let i = 0; i < repeat; i++) {
          if (signal.aborted) throw Error('Cancelled.');
          const r = await transport(providers[key].ping || providers[key].base + 'empty.php', {
            signal,
            agent: probeAgent,
            lookup: publicLookup,
            timeout: 2500,
          });
          if (!i && repeat > 1) continue;
          samples.push(r.ms);
        }
        return { key, ms: median(samples) };
      } catch {
        return null;
      } finally {
        probeAgent.destroy();
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(8, candidates.length) }, async () => {
        while (cursor < candidates.length && !signal.aborted) {
          const key = candidates[cursor++];
          checks.push(await probe(key, 1));
          job.phase = 'Choosing server · ' + checks.length + '/' + candidates.length;
        }
      }),
    );
    const shortlist = checks
      .filter(Boolean)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 5);
    const warmed = await Promise.all(shortlist.map((s) => probe(s.key, 3)));
    if (signal.aborted) throw Error('Cancelled.');
    selection = warmed.filter(Boolean).sort((a, b) => a.ms - b.ms);
    if (!selection.length)
      throw Error('No measurement server responded. Choose a server manually or try again later.');
    provider = selection[0].key;
  }
  if (provider.startsWith('ls-') && !providers[provider]) await serverList();
  if (!providers[provider]) throw Error('Choose a valid measurement server.');
  const endpoint = providers[provider],
    cloudflare = provider === 'cloudflare';
  requestSpacingMs ??= cloudflare ? 200 : 0;
  const config = {
    ...profiles[mode],
    ...(phaseMs === undefined ? {} : { phaseMs }),
    ...(capBytes === undefined ? {} : { capBytes }),
  };
  const agent = new https.Agent({ keepAlive: true, maxSockets: streams + 2 });
  const abort = () => {
    if (signal.aborted) throw Error('Cancelled.');
  };
  let nextRequest = 0;
  async function paced(url, options) {
    const now = performance.now(),
      slot = Math.max(now, nextRequest);
    nextRequest = slot + requestSpacingMs;
    if (slot > now)
      await new Promise((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(Error('Cancelled.'));
        };
        const timer = setTimeout(() => {
          options.signal.removeEventListener('abort', stop);
          resolve();
        }, slot - now);
        options.signal.addEventListener('abort', stop, { once: true });
        if (options.signal.aborted) stop();
      });
    if (options.signal.aborted) throw Error('Cancelled.');
    return transport(url, { ...options, lookup: publicLookup });
  }
  const result = {
    provider: endpoint.name,
    mode,
    downloadMbps: null,
    uploadMbps: null,
    downloadBytes: 0,
    uploadBytes: 0,
    latencyMs: null,
    jitterMs: null,
    loadedDownloadMs: null,
    loadedUploadMs: null,
    samples: [],
    streams,
    method:
      'Average acknowledged payload throughput over sustained parallel HTTPS transfers. Latency uses HTTPS.',
  };
  if (selection)
    result.serverSelection = selection.map((s) => ({
      name: providers[s.key].name,
      latencyMs: s.ms,
    }));
  job.result = result;
  job.progress = 0;
  job.phase = 'Latency';
  const latency = async (localSignal) => {
    const r = await paced(
      endpoint.ping || endpoint.base + (cloudflare ? '__down?bytes=0' : 'empty.php'),
      { signal: localSignal, agent, timeout: 5000 },
    );
    return r.ms;
  };
  try {
    const times = [];
    for (let i = 0; i < 9; i++) {
      abort();
      const ms = await latency(signal);
      if (i) times.push(ms);
      job.progress = i + 1;
      result.latencyMs = median(times);
    }
    result.jitterMs =
      times.slice(1).reduce((sum, v, i) => sum + Math.abs(v - times[i]), 0) / (times.length - 1);
    const payload = await new Promise((resolve, reject) =>
      crypto.randomBytes(10000000, (error, buffer) => (error ? reject(error) : resolve(buffer))),
    );
    for (const direction of ['download', 'upload']) {
      abort();
      const upload = direction === 'upload',
        budget = { reserved: 0 },
        loaded = [];
      async function phase(duration, warming) {
        const controller = new AbortController(),
          forward = () => controller.abort();
        signal.addEventListener('abort', forward, { once: true });
        if (signal.aborted) controller.abort();
        const began = performance.now();
        let bytes = 0,
          lastBytes = 0,
          lastAt = began,
          completed = 0,
          failure,
          stopping = false,
          probing = false;
        const maxBudget = warming ? Math.min(config.capBytes, 10000000) : config.capBytes;
        const label = (upload ? 'Upload' : 'Download') + (warming ? ' · warming up' : '');
        job.phase = label;
        result.liveMbps = null;
        const sample = () => {
          const now = performance.now(),
            elapsed = now - lastAt;
          if (elapsed < 100) return;
          const rate = ((bytes - lastBytes) * 8) / elapsed / 1000;
          lastBytes = bytes;
          lastAt = now;
          if (!warming) {
            result.liveMbps = rate;
            result.samples.push({ direction, seconds: (now - began) / 1000, mbps: rate });
            if (result.samples.length > 200) result.samples.shift();
            job.progress = (upload ? 55 : 10) + Math.min(42, (42 * (now - began)) / duration);
          }
        };
        const sampleTimer = setInterval(sample, 400);
        const latencyTimer = warming
          ? null
          : setInterval(async () => {
              if (probing || stopping) return;
              probing = true;
              try {
                loaded.push(await latency(controller.signal));
              } catch {
              } finally {
                probing = false;
              }
            }, 900);
        const workers = Array.from({ length: streams }, async () => {
          let size = upload ? 250000 : 1000000;
          try {
            while (!controller.signal.aborted && performance.now() - began < duration) {
              const remaining = maxBudget - budget.reserved;
              if (remaining < 64000) break;
              let amount = Math.min(
                remaining,
                Math.max(64000, Math.min(10000000, Math.round(size))),
              );
              // Public LibreSpeed backends commonly cap upload request bodies at 1 MiB.
              if (!cloudflare && upload) amount = Math.min(amount, 1048576);
              if (!cloudflare && !upload) {
                amount =
                  Math.min(
                    Math.floor(remaining / 1048576),
                    8,
                    Math.max(1, Math.ceil(amount / 1048576)),
                  ) * 1048576;
                if (!amount) break;
              }
              budget.reserved += amount;
              let url = cloudflare
                ? endpoint.base + (upload ? '__up' : '__down?bytes=' + amount)
                : upload
                  ? endpoint.upload || endpoint.base + 'empty.php'
                  : endpoint.download || endpoint.base + 'garbage.php';
              if (!cloudflare && !upload) {
                const target = new URL(url);
                target.searchParams.set('ckSize', String(amount / 1048576));
                url = target.href;
              }
              const r = await paced(url, {
                method: upload ? 'POST' : 'GET',
                body: upload ? payload.subarray(0, amount) : undefined,
                agent,
                signal: controller.signal,
                timeout: 15000,
                onBytes: (n) => {
                  if (!upload) {
                    bytes += n;
                    result.downloadBytes += n;
                  }
                },
              });
              if (upload) {
                bytes += amount;
                result.uploadBytes += amount;
              } else if (r.bytes !== amount) throw Error('The test download was incomplete.');
              completed++;
              size = (amount * 1800) / Math.max(1, r.ms);
              if (!warming && cloudflare && amount === 10000000 && r.ms < 800)
                result[direction + 'ProviderLimited'] = true;
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              failure = error;
              controller.abort();
            }
          }
        });
        try {
          await Promise.all(workers);
          stopping = true;
          sample();
          abort();
          if (failure) throw failure;
          const elapsed = performance.now() - began;
          if (!warming) {
            if (!completed) throw Error('No transfer completed. Try again.');
            result[direction + 'Mbps'] = (bytes * 8) / elapsed / 1000;
            result[direction + 'Seconds'] = elapsed / 1000;
            result[direction + 'Capped'] = budget.reserved >= config.capBytes - 64000;
            result[direction + 'MeasuredBytes'] = bytes;
          }
        } finally {
          clearInterval(sampleTimer);
          clearInterval(latencyTimer);
          controller.abort();
          signal.removeEventListener('abort', forward);
        }
      }
      await phase(warmupMs, true);
      await phase(config.phaseMs, false);
      result[upload ? 'loadedUploadMs' : 'loadedDownloadMs'] = median(loaded);
    }
    result.liveMbps = result.downloadMbps;
    job.phase = 'Complete';
    job.progress = 100;
    return result;
  } finally {
    agent.destroy();
  }
}
module.exports = { measure, profiles, providers, serverList };
