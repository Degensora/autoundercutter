import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, base32Decode, secondsRemaining } from '../src/marketplaces/totp.js';
import { TicketAttendantClient } from '../src/marketplaces/ticketattendant.js';

test('TOTP matches the RFC 6238 reference vectors', () => {
  // RFC 6238 test secret "12345678901234567890" = base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totp(secret, { now: 59 * 1000 }), '287082');
  assert.equal(totp(secret, { now: 1111111109 * 1000 }), '081804');
  assert.equal(totp(secret, { now: 1234567890 * 1000 }), '005924');
  assert.equal(totp(`otpauth://totp/TA:me?secret=${secret}&issuer=TA`, { now: 59 * 1000 }), '287082');
  assert.ok(secondsRemaining(secret) >= 1 && secondsRemaining(secret) <= 30);
});

const AUTH_PAGE = `<html><body><h3>Two-step verification</h3>
<form action="/login/verify?ReturnUrl=%2f" method="post">
<input name="__RequestVerificationToken" type="hidden" value="tok123" />
<input name="Provider" type="hidden" value="Authenticator" />
<label for="Code">Enter the code from your authenticator app</label>
<input id="Code" name="Code" type="text" autocomplete="off" />
<input id="RememberBrowser" name="RememberBrowser" type="checkbox" value="true" /><input name="RememberBrowser" type="hidden" value="false" />
<button type="submit">Verify</button></form></body></html>`;

test('parses the authenticator form generically', () => {
  const f = TicketAttendantClient.parseAuthenticatorForm(AUTH_PAGE, 'https://ta.test/login');
  assert.equal(f.action, 'https://ta.test/login/verify?ReturnUrl=%2f');
  assert.equal(f.codeField, 'Code');
  assert.deepEqual(f.fields, { __RequestVerificationToken: 'tok123', Provider: 'Authenticator', RememberBrowser: 'true' });
  assert.match(f.prompt, /authenticator app/);
  const loginPage = '<form action="/login" method="post"><input name="UserName" type="text" value="" /><input name="Password" type="password" /></form>';
  assert.equal(TicketAttendantClient.parseAuthenticatorForm(loginPage, 'https://ta.test/login'), null);
});

function taServer({ requireCode = true, acceptCode = '123456' } = {}) {
  const calls = [];
  let passwordOk = false;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body, cookie: init.headers?.Cookie || '' });
    if (u.pathname === '/login' && (init.method || 'GET') === 'GET') {
      return new Response('<form action="/login" method="post"><input name="UserName" /><input name="Password" type="password" /></form>', { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=s1; path=/' } });
    }
    if (u.pathname === '/login' && init.method === 'POST') {
      const b = new URLSearchParams(init.body);
      if (b.get('Password') !== 'pw') return new Response('<div class="validation-summary-errors"><ul><li>Invalid username or password.</li></ul></div>', { status: 200, headers: { 'content-type': 'text/html' } });
      passwordOk = true;
      if (!requireCode) return new Response('', { status: 302, headers: { location: '/', 'set-cookie': '.ASPXAUTH=full; path=/' } });
      return new Response('', { status: 302, headers: { location: '/login/verify?ReturnUrl=%2f' } });
    }
    if (u.pathname === '/login/verify' && (init.method || 'GET') === 'GET') {
      return new Response(AUTH_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (u.pathname === '/login/verify' && init.method === 'POST') {
      const b = new URLSearchParams(init.body);
      if (!passwordOk || b.get('Code') !== acceptCode || b.get('__RequestVerificationToken') !== 'tok123') {
        return new Response(AUTH_PAGE.replace('<h3>', '<span class="text-danger">Invalid code.</span><h3>'), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('', { status: 302, headers: { location: '/', 'set-cookie': '.ASPXAUTH=full; path=/; expires=Fri, 22-Sep-2026 00:00:00 GMT' } });
    }
    if (u.pathname === '/get-shdata') {
      if (!/\.ASPXAUTH=full/.test(init.headers?.Cookie || '')) return new Response('', { status: 302, headers: { location: '/login?ReturnUrl=%2fget-shdata' } });
      return new Response(JSON.stringify(['', '<rows></rows>', [], '', '', [], 0]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetch, calls };
}

test('two-step login: waits for the authenticator code, then works', async () => {
  const { fetch } = taServer();
  const saved = [];
  const c = new TicketAttendantClient({ baseUrl: 'https://ta.test', username: 'me', password: 'pw', fetch, onCookies: (h) => saved.push(h) });
  await assert.rejects(() => c.postJson('get-shdata', {}), /authenticator code/);
  assert.equal(c.authState, 'needs_code');
  assert.match(c.status().codePrompt, /authenticator/);
  // while waiting, API calls do not start a second login
  await assert.rejects(() => c.postJson('get-shdata', {}), /Waiting for the authenticator code/);
  await assert.rejects(() => c.submitCode('000000'), /Invalid code/);
  assert.equal(c.authState, 'needs_code');
  await c.submitCode('123 456');
  assert.equal(c.authState, 'ok');
  assert.ok(saved.at(-1).includes('.ASPXAUTH=full'));
  const data = await c.postJson('get-shdata', {});
  assert.equal(data[6], 0);
});

test('TOTP secret answers the authenticator step automatically', async () => {
  const code = totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const { fetch, calls } = taServer({ acceptCode: code });
  const c = new TicketAttendantClient({ baseUrl: 'https://ta.test', username: 'me', password: 'pw', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', fetch });
  const data = await c.postJson('get-shdata', {});
  assert.equal(data[6], 0);
  assert.equal(c.authState, 'ok');
  assert.ok(calls.some((k) => k.path === '/login/verify' && k.method === 'POST'));
});

test('wrong password is reported clearly; pasted cookie works without a login', async () => {
  const { fetch } = taServer();
  const bad = new TicketAttendantClient({ baseUrl: 'https://ta.test', username: 'me', password: 'nope', fetch });
  await assert.rejects(() => bad.login(), /Invalid username or password/);
  assert.equal(bad.authState, 'error');
  const c = new TicketAttendantClient({ baseUrl: 'https://ta.test', fetch });
  assert.equal(c.authState, 'needs_credentials');
  c.setCookieHeader('.ASPXAUTH=full; ASP.NET_SessionId=x');
  assert.equal(c.authState, 'ok');
  assert.equal((await c.postJson('get-shdata', {}))[6], 0);
  assert.throws(() => c.setCookieHeader('ASP.NET_SessionId=only'), /ASPXAUTH/);
});
