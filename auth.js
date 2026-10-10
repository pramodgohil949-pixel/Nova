const L = require('./_lib');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = L.handler(async (req, res) => {
  const q = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = q.action || body.action;

  // Public config: Discord link, banner text, site name
  if (action === 'config') {
    const banner = (await L.redis(['GET', 'cfg:banner'])) || '';
    return L.send(res, 200, {
      name: process.env.SITE_NAME || 'NovaAI',
      discord: process.env.DISCORD_INVITE || '',
      banner,
      limits: L.LIMITS,
    });
  }

  // Who am I (validates stored token)
  if (action === 'me') {
    const u = await L.getAuth(req);
    if (!u || u.banned) return L.send(res, 200, { user: null });
    return L.send(res, 200, { user: L.publicUser(u) });
  }

  if (req.method !== 'POST') return L.send(res, 405, { error: 'Use POST' });

  const email = String(body.email || '').toLowerCase().trim();
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email)) return L.send(res, 400, { error: 'Enter a valid email.' });
  if (password.length < 8 || password.length > 200) return L.send(res, 400, { error: 'Password must be 8+ characters.' });

  if (action === 'signup') {
    const name = String(body.name || '').trim().slice(0, 40) || email.split('@')[0];
    const key = `signup:${L.today()}:${L.ipOf(req)}`;
    const n = await L.redis(['INCR', key]);
    if (n === 1) await L.redis(['EXPIRE', key, 172800]);
    if (n > 10) return L.send(res, 429, { error: 'Too many signups from this network today.' });

    if (await L.getUser(email)) return L.send(res, 409, { error: 'Account already exists. Sign in instead.' });
    const user = {
      name, email, pass: L.hashPw(password),
      role: L.ADMIN_EMAIL && email === L.ADMIN_EMAIL ? 'admin' : 'user',
      banned: false, created: Date.now(),
    };
    await L.saveUser(user);
    await L.redis(['SADD', 'users', email]);
    return L.send(res, 200, { token: L.makeToken(email), user: L.publicUser(user) });
  }

  if (action === 'signin') {
    const user = await L.getUser(email);
    if (!user || !L.checkPw(password, user.pass)) return L.send(res, 401, { error: 'Wrong email or password.' });
    if (user.banned) return L.send(res, 403, { error: 'Your account is suspended.' });
    // If ADMIN_EMAIL was set after signup, promote on login
    if (L.ADMIN_EMAIL && email === L.ADMIN_EMAIL && user.role !== 'admin') { user.role = 'admin'; await L.saveUser(user); }
    return L.send(res, 200, { token: L.makeToken(email), user: L.publicUser(user) });
  }

  return L.send(res, 400, { error: 'Unknown action.' });
});
