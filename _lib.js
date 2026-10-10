const crypto = require('crypto');

const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

// Free daily limits. Edit freely.
const LIMITS = {
  guest: { chat: 10, code: 5, image: 3, video: 0 },
  user: { chat: 100, code: 50, image: 30, video: 3 },
};

/* ---------- storage: Upstash Redis (free) or in-memory fallback for local dev ---------- */
const mem = global.__novaMem || (global.__novaMem = { kv: new Map(), sets: new Map() });
function memCmd([c, ...a]) {
  c = c.toUpperCase();
  if (c === 'GET') return mem.kv.has(a[0]) ? mem.kv.get(a[0]) : null;
  if (c === 'SET') { mem.kv.set(a[0], String(a[1])); return 'OK'; }
  if (c === 'INCR') { const v = parseInt(mem.kv.get(a[0]) || '0', 10) + 1; mem.kv.set(a[0], String(v)); return v; }
  if (c === 'EXPIRE') return 1;
  if (c === 'DEL') { mem.kv.delete(a[0]); return 1; }
  if (c === 'SADD') { if (!mem.sets.has(a[0])) mem.sets.set(a[0], new Set()); mem.sets.get(a[0]).add(a[1]); return 1; }
  if (c === 'SREM') { const s = mem.sets.get(a[0]); if (s) s.delete(a[1]); return 1; }
  if (c === 'SMEMBERS') return [...(mem.sets.get(a[0]) || [])];
  if (c === 'SCARD') return (mem.sets.get(a[0]) || new Set()).size;
  throw new Error('Unsupported command ' + c);
}
async function redis(cmd) {
  if (!RURL) return memCmd(cmd);
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

/* ---------- crypto ---------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  const real = Buffer.from(h, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}
const b64 = (s) => Buffer.from(s).toString('base64url');
function makeToken(email, days = 30) {
  const body = b64(JSON.stringify({ e: email, x: Date.now() + days * 864e5 }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function readToken(t) {
  try {
    const [body, sig] = String(t).split('.');
    const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.x > Date.now() ? p : null;
  } catch { return null; }
}

/* ---------- users / auth ---------- */
async function getUser(email) {
  const raw = await redis(['GET', 'user:' + email]);
  return raw ? JSON.parse(raw) : null;
}
async function saveUser(u) { await redis(['SET', 'user:' + u.email, JSON.stringify(u)]); }
async function getAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const p = readToken(h.slice(7));
  if (!p) return null;
  return await getUser(p.e);
}
const publicUser = (u) => ({ name: u.name, email: u.email, role: u.role });

/* ---------- helpers ---------- */
const send = (res, code, obj) => res.status(code).json(obj);
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'ip').split(',')[0].trim();
const today = () => new Date().toISOString().slice(0, 10);
const handler = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(e); send(res, 500, { error: 'Server error: ' + e.message }); }
};

/* ---------- daily quota. Returns the caller, or null after sending an error ---------- */
async function quota(req, res, feature, { charge = true } = {}) {
  const user = await getAuth(req);
  if (user && user.banned) { send(res, 403, { error: 'Your account is suspended.' }); return null; }
  const tier = user ? 'user' : 'guest';
  const limit = user && user.role === 'admin' ? Infinity : LIMITS[tier][feature];
  if (!user && limit === 0) {
    send(res, 401, { error: 'Sign up free to unlock ' + feature + ' generation.', needAuth: true });
    return null;
  }
  if (charge) {
    const id = user ? 'u:' + user.email : 'g:' + ipOf(req);
    const n = await redis(['INCR', `q:${today()}:${id}:${feature}`]);
    if (n === 1) await redis(['EXPIRE', `q:${today()}:${id}:${feature}`, 172800]);
    if (n > limit) {
      send(res, 429, { error: `Daily ${feature} limit reached (${limit}).` + (user ? ' Try again tomorrow.' : ' Sign up free for more.'), needAuth: !user });
      return null;
    }
    await redis(['INCR', `stat:${today()}:${feature}`]);
  }
  return user || { guest: true };
}

module.exports = {
  redis, hashPw, checkPw, makeToken, readToken, getUser, saveUser, getAuth, publicUser,
  send, ipOf, today, handler, quota, ADMIN_EMAIL, LIMITS,
};
