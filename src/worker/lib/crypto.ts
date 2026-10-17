// Web Crypto helpers (available natively in Workers). No secrets are ever logged.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export const b64url = (bytes: ArrayBuffer | Uint8Array): string => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomBytes(n: number): Uint8Array {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}
export const randomToken = (n = 32): string => b64url(randomBytes(n));

export async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmacRaw(keyBytes: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function masterKey(secret: string | undefined): Uint8Array {
  if (!secret) throw new ConfigError('ENCRYPTION_KEY secret is not configured');
  let raw: Uint8Array;
  try { raw = unb64(secret.trim()); } catch { throw new ConfigError('ENCRYPTION_KEY must be base64'); }
  if (raw.length < 32) throw new ConfigError('ENCRYPTION_KEY must decode to at least 32 bytes');
  return raw;
}

export class ConfigError extends Error {}

/** Sub-keys are derived so that one secret is never used for two algorithms. */
const subKey = async (secret: string | undefined, purpose: string) => hmacRaw(masterKey(secret), `tg-attendance:${purpose}`);

export async function encryptString(secret: string | undefined, plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await subKey(secret, 'aes-gcm'), 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptString(secret: string | undefined, payload: string): Promise<string> {
  const [v, ivS, ctS] = payload.split(':');
  if (v !== 'v1' || !ivS || !ctS) throw new Error('Unsupported ciphertext format');
  const key = await crypto.subtle.importKey('raw', await subKey(secret, 'aes-gcm'), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivS) }, key, unb64(ctS));
  return dec.decode(pt);
}

/** Telegram secret_token for a bot: 1–256 chars of [A-Za-z0-9_-]. Derived, so it is never stored. */
export async function webhookSecret(secret: string | undefined, botId: number, salt: string): Promise<string> {
  return b64url(await hmacRaw(await subKey(secret, 'webhook'), `wh:${botId}:${salt}`));
}

// ---------------------------------------------------------------- passwords (PBKDF2-SHA256)
export const PBKDF2_ITERATIONS = 100_000; // the maximum Workers' Web Crypto accepts

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, it, saltS, hashS] = stored.split('$');
  if (alg !== 'pbkdf2-sha256' || !it || !saltS || !hashS) return false;
  const iterations = Number(it);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_ITERATIONS) return false;
  const hash = await pbkdf2(password, unb64(saltS), iterations);
  return safeEqual(b64(hash), hashS);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Removes anything that looks like a bot token from text before it is logged or stored. */
export const redact = (s: string): string => s.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '<redacted-token>');
