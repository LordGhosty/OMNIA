const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identifyLink, resolveShortLink } = require('../src/links.cjs');
const short = 'https://pin.it/TestPin01';
const bridge = 'https://api.pinterest.com/url_shortener/TestPin01/redirect/';
const pin = 'https://www.pinterest.com/pin/1234567890123456789/';
const signal = () => new AbortController().signal;
test('Pinterest copied share links resolve through the official shortener to a clean pin URL', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: {
        location: url === short ? bridge : pin + 'sent/?invite_code=example&sender=example',
      },
    });
  };
  assert.deepEqual(await resolveShortLink(identifyLink(short), signal(), fetcher), {
    platform: 'Pinterest',
    url: pin,
  });
  assert.deepEqual(seen, [short, bridge]);
  assert.equal(identifyLink(pin + 'sent/?tracking=1').url, pin);
  assert.equal(
    identifyLink('https://gr.pinterest.com/pin/a-caption--1234567890123456789/').url,
    pin,
  );
});
test('Pinterest shortener rejects unrelated or unsafe redirect targets before following them', async () => {
  for (const target of [
    'http://127.0.0.1/private',
    'https://api.pinterest.com.evil.test/url_shortener/a/redirect/',
    'https://api.pinterest.com/other',
    'https://user:secret@api.pinterest.com/url_shortener/a/redirect/',
    'http://api.pinterest.com/url_shortener/a/redirect/',
    'https://api.pinterest.com:444/url_shortener/a/redirect/',
    'https://youtu.be/Fixture0001',
  ]) {
    let requests = 0;
    await assert.rejects(
      resolveShortLink(identifyLink(short), signal(), async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: target } });
      }),
    );
    assert.equal(requests, 1);
  }
});
test('Pinterest redirect loops and missing destinations stop with useful errors', async () => {
  let requests = 0;
  await assert.rejects(
    resolveShortLink(identifyLink(short), signal(), async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location: bridge } });
    }),
    /Too many redirects/,
  );
  assert.equal(requests, 6);
  await assert.rejects(
    resolveShortLink(
      identifyLink(short),
      signal(),
      async () => new Response(null, { status: 200 }),
    ),
    /full pin URL/,
  );
});
