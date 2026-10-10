const L = require('./_lib');

// Video runs on fal.ai (free signup credits). Model is configurable.
const MODEL = () => process.env.FAL_VIDEO_MODEL || 'fal-ai/ltx-video';
const H = () => ({ Authorization: 'Key ' + process.env.FAL_KEY, 'Content-Type': 'application/json' });

module.exports = L.handler(async (req, res) => {
  if (!process.env.FAL_KEY) return L.send(res, 503, { error: 'Video is not configured yet. Admin: add FAL_KEY in Vercel env vars.' });

  // Poll: GET /api/video?id=REQUEST_ID  (never charges quota)
  if (req.method === 'GET') {
    if (!(await L.quota(req, res, 'video', { charge: false }))) return;
    const id = String((req.query || {}).id || '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!id) return L.send(res, 400, { error: 'Missing id' });
    const s = await fetch(`https://queue.fal.run/${MODEL()}/requests/${id}/status`, { headers: H() });
    if (!s.ok) return L.send(res, 502, { error: 'Status check failed (' + s.status + ')' });
    const st = await s.json();
    if (st.status === 'COMPLETED') {
      const r = await fetch(`https://queue.fal.run/${MODEL()}/requests/${id}`, { headers: H() });
      const j = await r.json();
      const url = j.video?.url || j.data?.video?.url;
      if (!url) return L.send(res, 502, { status: 'failed', error: 'Video finished but no file returned.' });
      return L.send(res, 200, { status: 'done', url });
    }
    return L.send(res, 200, { status: 'working', position: st.queue_position ?? null });
  }

  // Start: POST /api/video {prompt}
  if (req.method !== 'POST') return L.send(res, 405, { error: 'Use GET or POST' });
  const prompt = String((req.body || {}).prompt || '').trim().slice(0, 600);
  if (prompt.length < 5) return L.send(res, 400, { error: 'Describe the video you want.' });
  if (!(await L.quota(req, res, 'video'))) return;

  const r = await fetch(`https://queue.fal.run/${MODEL()}`, { method: 'POST', headers: H(), body: JSON.stringify({ prompt }) });
  if (!r.ok) {
    console.error('fal submit', r.status, (await r.text()).slice(0, 200));
    return L.send(res, 502, { error: 'Video service refused the request (credits may be used up).' });
  }
  const j = await r.json();
  return L.send(res, 200, { id: j.request_id });
});
