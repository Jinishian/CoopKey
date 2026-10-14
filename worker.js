/* CoopKey API: accounts + cloud vault sync for Cloudflare Workers + D1.
   Single file, no imports, so it can be pasted into the Cloudflare dashboard editor.

   Bindings / settings:
     DB               D1 database (run schema.sql in it)
     JWT_SECRET       secret, 32+ random characters (signs login tokens)
     ALLOWED_ORIGINS  optional variable, comma-separated web addresses allowed to call the API

   Endpoints:
     GET  /health
     POST /signup           {name,email,password}        -> {token,user}
     POST /signin           {email,password}             -> {token,user}
     GET  /me                                            -> {user}
     GET  /vault                                         -> {data,updated}
     PUT  /vault            {data,base}                  -> {ok,updated}   (409 if base is stale)
     POST /password         {current,next}               -> {ok,token}
     DELETE /account        {password}                   -> {ok}
*/

const enc = new TextEncoder();
const PBKDF2_ITERS = 100000;            // Workers' maximum
const TOKEN_TTL_SEC = 60 * 24 * 3600;   // 60 days
const MAX_BODY_BYTES = 1_600_000;       // D1 rows are limited to about 2 MB
const TAURI_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }

/* ---------- small helpers ---------- */
const b64u = {
  enc(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
};
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(headers || {}) } });
}
function corsHeaders(origin, env) {
  const h = { 'Vary': 'Origin' };
  if (!origin) return h;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = list.length === 0 || list.includes('*') || list.includes(origin) || TAURI_ORIGINS.includes(origin);
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type,Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
async function readJson(req, limit) {
  const text = await req.text();
  if (text.length > (limit || 20000)) throw new HttpError(413, 'Request too large.');
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw new HttpError(400, 'Invalid JSON.'); }
}
function cleanEmail(e) { return String(e || '').trim().toLowerCase(); }
function validEmail(e) { return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, plan: u.plan, joined: u.joined }; }

/* ---------- passwords + tokens ---------- */
async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITERS }, key, 256);
  return new Uint8Array(bits);
}
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
async function hashNew(password) { const salt = crypto.getRandomValues(new Uint8Array(16)); const hash = await pbkdf2(password, salt); return { salt: b64u.enc(salt), hash: b64u.enc(hash) }; }
async function passwordMatches(password, user) {
  const got = await pbkdf2(password, b64u.dec(user.salt));
  return timingSafeEqual(got, b64u.dec(user.hash));
}
async function hmacKey(env, usage) {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) throw new HttpError(500, 'Server is missing JWT_SECRET.');
  return crypto.subtle.importKey('raw', enc.encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
async function makeToken(env, user) {
  const payload = b64u.enc(enc.encode(JSON.stringify({ sub: user.id, pv: user.pw_ver, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env, 'sign'), enc.encode('v1.' + payload));
  return 'v1.' + payload + '.' + b64u.enc(sig);
}
async function userFromToken(env, req) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) throw new HttpError(401, 'Please sign in.');
  const parts = m[1].split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new HttpError(401, 'Please sign in again.');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env, 'verify'), b64u.dec(parts[2]), enc.encode('v1.' + parts[1])); } catch (e) { ok = false; }
  if (!ok) throw new HttpError(401, 'Please sign in again.');
  let p; try { p = JSON.parse(new TextDecoder().decode(b64u.dec(parts[1]))); } catch (e) { throw new HttpError(401, 'Please sign in again.'); }
  if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) throw new HttpError(401, 'Your session expired. Please sign in again.');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(p.sub).first();
  if (!user || user.pw_ver !== p.pv) throw new HttpError(401, 'Please sign in again.');
  return user;
}

/* ---------- rate limiting (per key, fixed window, stored in D1) ---------- */
async function throttle(env, key, limit, windowSec) {
  const w = Math.floor(Date.now() / 1000 / windowSec);
  await env.DB.prepare('INSERT INTO rate (k, w, n) VALUES (?, ?, 1) ON CONFLICT(k, w) DO UPDATE SET n = n + 1').bind(key, w).run();
  const row = await env.DB.prepare('SELECT n FROM rate WHERE k = ? AND w = ?').bind(key, w).first();
  if (row && row.n > limit) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate WHERE w < ?').bind(w - 2).run();
}

/* ---------- routes ---------- */
async function signup(env, req, ip) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), name = String(b.name || '').trim().slice(0, 80) || 'Keeper', password = String(b.password || '');
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Use a password with at least 8 characters.');
  if (password.length > 200) throw new HttpError(400, 'That password is too long.');
  await throttle(env, 'signup:' + ip, 10, 3600);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'An account with that email already exists.');
  const { salt, hash } = await hashNew(password);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(9))).map(x => (x % 36).toString(36)).join('');
  const joined = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, salt, hash, pw_ver, plan, joined) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').bind(id, email, name, salt, hash, 'free', joined).run();
  const user = { id, email, name, plan: 'free', joined, pw_ver: 1 };
  return { token: await makeToken(env, user), user: publicUser(user) };
}
async function signin(env, req, ip) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), password = String(b.password || '');
  if (!email || !password || password.length > 200) throw new HttpError(400, 'Enter your email and password.');
  await throttle(env, 'signin:' + ip + ':' + email, 10, 900);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) { await pbkdf2(password, new Uint8Array(16)); throw new HttpError(401, 'Email or password is incorrect.'); }
  if (!(await passwordMatches(password, user))) throw new HttpError(401, 'Email or password is incorrect.');
  return { token: await makeToken(env, user), user: publicUser(user) };
}
async function getVault(env, user) {
  const row = await env.DB.prepare('SELECT data, updated FROM vaults WHERE user_id = ?').bind(user.id).first();
  if (!row) return { data: null, updated: 0 };
  return { data: JSON.parse(row.data), updated: row.updated };
}
async function putVault(env, user, req) {
  const body = await readJson(req, MAX_BODY_BYTES);
  if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) throw new HttpError(400, 'Missing data.');
  const text = JSON.stringify(body.data);
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Your data is too large to sync.');
  const row = await env.DB.prepare('SELECT updated FROM vaults WHERE user_id = ?').bind(user.id).first();
  const base = body.base;
  const checking = base !== undefined && base !== null;
  const current = row ? row.updated : 0;
  const updated = Math.max(Date.now(), current + 1);
  const conflict = () => new HttpError(409, 'conflict', { updated: current });
  if (!row) {
    if (checking && base !== 0) throw conflict();
    const r = await env.DB.prepare('INSERT OR IGNORE INTO vaults (user_id, data, updated) VALUES (?, ?, ?)').bind(user.id, text, updated).run();
    if (!r.meta || r.meta.changes === 0) throw conflict();
  } else if (checking) {
    if (base !== current) throw conflict();
    const r = await env.DB.prepare('UPDATE vaults SET data = ?, updated = ? WHERE user_id = ? AND updated = ?').bind(text, updated, user.id, current).run();
    if (!r.meta || r.meta.changes === 0) throw conflict();
  } else {
    await env.DB.prepare('UPDATE vaults SET data = ?, updated = ? WHERE user_id = ?').bind(text, updated, user.id).run();
  }
  return { ok: true, updated };
}
async function changePassword(env, user, req) {
  const b = await readJson(req);
  const next = String(b.next || '');
  if (!(await passwordMatches(String(b.current || ''), user))) throw new HttpError(401, 'Your current password is incorrect.');
  if (next.length < 8 || next.length > 200) throw new HttpError(400, 'Use a new password with at least 8 characters.');
  const { salt, hash } = await hashNew(next);
  const pw_ver = user.pw_ver + 1;
  await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, pw_ver = ? WHERE id = ?').bind(salt, hash, pw_ver, user.id).run();
  return { ok: true, token: await makeToken(env, { ...user, pw_ver }) };
}
async function deleteAccount(env, user, req) {
  const b = await readJson(req);
  if (!(await passwordMatches(String(b.password || ''), user))) throw new HttpError(401, 'Password is incorrect.');
  await env.DB.prepare('DELETE FROM vaults WHERE user_id = ?').bind(user.id).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  return { ok: true };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const m = req.method;
      if (path === '/health' && m === 'GET') return json({ ok: true }, 200, cors);
      if (path === '/signup' && m === 'POST') return json(await signup(env, req, ip), 200, cors);
      if (path === '/signin' && m === 'POST') return json(await signin(env, req, ip), 200, cors);
      if (path === '/me' && m === 'GET') return json({ user: publicUser(await userFromToken(env, req)) }, 200, cors);
      if (path === '/vault' && m === 'GET') return json(await getVault(env, await userFromToken(env, req)), 200, cors);
      if (path === '/vault' && m === 'PUT') return json(await putVault(env, await userFromToken(env, req), req), 200, cors);
      if (path === '/password' && m === 'POST') return json(await changePassword(env, await userFromToken(env, req), req), 200, cors);
      if (path === '/account' && m === 'DELETE') return json(await deleteAccount(env, await userFromToken(env, req), req), 200, cors);
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status, cors);
      console.error('Unhandled error', e && e.stack || e);
      return json({ error: 'Server error. Please try again.' }, 500, cors);
    }
  },
};
