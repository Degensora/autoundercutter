/**
 * RFC 6238 time-based one-time passwords (what Google Authenticator / Authy / 1Password generate).
 * Given the secret from the authenticator QR code (base32), this produces the same 6-digit code.
 */
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean) throw new Error('Empty TOTP secret');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid character "${ch}" in TOTP secret`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Accepts a raw base32 secret or a full otpauth:// URL. */
export function parseSecret(input) {
  const s = String(input || '').trim();
  if (/^otpauth:\/\//i.test(s)) {
    const url = new URL(s);
    const secret = url.searchParams.get('secret');
    if (!secret) throw new Error('otpauth URL has no secret');
    return {
      secret,
      digits: Number(url.searchParams.get('digits')) || 6,
      period: Number(url.searchParams.get('period')) || 30,
      algorithm: (url.searchParams.get('algorithm') || 'SHA1').toLowerCase(),
    };
  }
  return { secret: s, digits: 6, period: 30, algorithm: 'sha1' };
}

export function totp(secretInput, { now = Date.now(), offsetSteps = 0 } = {}) {
  const { secret, digits, period, algorithm } = parseSecret(secretInput);
  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / period) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Seconds until the current code rolls over. */
export function secondsRemaining(secretInput, now = Date.now()) {
  const { period } = parseSecret(secretInput);
  return period - (Math.floor(now / 1000) % period);
}
