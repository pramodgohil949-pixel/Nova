const L = require('./_lib');

const SIZES = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] };

async function viaHuggingFace(prompt, [w, h]) {
  const model = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';
  const r = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.HF_TOKEN, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify({ inputs: prompt, parameters: { width: w, height: h } }),
  });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) throw new Error('HF: ' + r.status + ' ' + (await r.text()).slice(0, 150));
  return 'data:' + type + ';base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function viaPollinations(prompt, [w, h]) {
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=flux&width=${w}&height=${h}&seed=${seed}&nologo=true`;
  const r = await fetch(url, process.env.POLLINATIONS_TOKEN ? { headers: { Authorization: 'Bearer ' + process.env.POLLINATIONS_TOKEN } } : {});
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) throw new Error('Pollinations: ' + r.status);
  return 'data:' + type + ';base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
}

module.exports = L.handler(async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'Use POST' });
  const prompt = String((req.body || {}).prompt || '').trim().slice(0, 800);
  const size = SIZES[(req.body || {}).size] || SIZES.square;
  if (prompt.length < 3) return L.send(res, 400, { error: 'Describe the image you want.' });
  if (!(await L.quota(req, res, 'image'))) return;

  const errors = [];
  if (process.env.HF_TOKEN) {
    try { return L.send(res, 200, { image: await viaHuggingFace(prompt, size), provider: 'huggingface-flux' }); }
    catch (e) { errors.push(e.message); }
  }
  try { return L.send(res, 200, { image: await viaPollinations(prompt, size), provider: 'pollinations-flux' }); }
  catch (e) { errors.push(e.message); }

  console.error('image failed', errors);
  return L.send(res, 502, { error: 'Image servers are busy. Try again in a few seconds.' });
});
