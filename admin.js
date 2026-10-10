const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const me = await L.getAuth(req);
  if (!me || me.role !== 'admin' || me.banned) return L.send(res, 403, { error: 'Admin only.' });

  const q = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = q.action || body.action;

  if (action === 'stats') {
    const feats = ['chat', 'code', 'image', 'video'];
    const day = L.today();
    const usage = {};
    for (const f of feats) usage[f] = parseInt((await L.redis(['GET', `stat:${day}:${f}`])) || '0', 10);
    const users = await L.redis(['SCARD', 'users']);
    const banner = (await L.redis(['GET', 'cfg:banner'])) || '';
    return L.send(res, 200, { users, usage, banner, day });
  }

  if (action === 'users') {
    const emails = (await L.redis(['SMEMBERS', 'users'])) || [];
    const list = (await Promise.all(emails.slice(0, 500).map((e) => L.getUser(e)))).filter(Boolean)
      .map((u) => ({ name: u.name, email: u.email, role: u.role, banned: !!u.banned, created: u.created }))
      .sort((a, b) => b.created - a.created);
    return L.send(res, 200, { users: list });
  }

  if (req.method !== 'POST') return L.send(res, 405, { error: 'Use POST' });

  if (action === 'banner') {
    const text = String(body.text || '').slice(0, 200);
    if (text) await L.redis(['SET', 'cfg:banner', text]); else await L.redis(['DEL', 'cfg:banner']);
    return L.send(res, 200, { ok: true });
  }

  const email = String(body.email || '').toLowerCase().trim();
  const target = await L.getUser(email);
  if (!target) return L.send(res, 404, { error: 'User not found.' });
  if (target.email === me.email) return L.send(res, 400, { error: "You can't do that to yourself." });

  if (action === 'ban') {
    target.banned = !!body.banned;
    await L.saveUser(target);
    return L.send(res, 200, { ok: true });
  }
  if (action === 'delete') {
    await L.redis(['DEL', 'user:' + email]);
    await L.redis(['SREM', 'users', email]);
    return L.send(res, 200, { ok: true });
  }
  if (action === 'role') {
    target.role = body.role === 'admin' ? 'admin' : 'user';
    await L.saveUser(target);
    return L.send(res, 200, { ok: true });
  }
  return L.send(res, 400, { error: 'Unknown action.' });
});
