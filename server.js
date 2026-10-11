require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MATERIALS = ['PLASTIC', 'PAPER', 'METAL', 'ORGANIC'];
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ORIGINS = (process.env.FRONTEND_URL || '*').split(',').map(s => s.trim().replace(/\/+$/, ''));
let irTriggerPending = false;
let lastIrTriggerAt = 0;
const IR_DEBOUNCE_MS = 1500;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROMPT = `You are the vision classifier for a waste-sorting prototype. Inspect the image and classify the main visible waste item into exactly one category: PLASTIC, PAPER, METAL, or ORGANIC. ORGANIC means food scraps or other clearly biodegradable organic waste. If the image is empty, blurry, has multiple ambiguous items, or cannot be classified reliably, return UNKNOWN. Do not claim laboratory-level certainty. Reply with only valid JSON in this exact shape: {"material":"PLASTIC|PAPER|METAL|ORGANIC|UNKNOWN","confidence":0,"item":"short item name","reason":"one short sentence"}. Confidence is an estimate from 0 to 100.`;

app.get('/health', (_req, res) => res.json({ ok: true, project: 'VERDIX' }));
app.get('/api/status', (_req, res) => res.json({
  ai: Boolean(API_KEY),
  model: MODEL,
  esp32: process.env.ESP32_URL ? 'configured' : 'simulation',
  irTrigger: true,
}));

// The ESP32 posts here when its IR sensor detects a new object.
// Set IR_TRIGGER_TOKEN in the backend and in the ESP32 sketch for basic protection.
app.post('/api/ir-trigger', (req, res) => {
  const expected = String(process.env.IR_TRIGGER_TOKEN || '').trim();
  const supplied = String(req.get('x-ir-token') || '').trim();
  if (expected && supplied !== expected) return res.status(401).json({ error: 'Invalid IR trigger token.' });
  const now = Date.now();
  if (now - lastIrTriggerAt < IR_DEBOUNCE_MS) return res.json({ ok: true, ignored: true, message: 'Trigger debounced.' });
  lastIrTriggerAt = now;
  irTriggerPending = true;
  res.json({ ok: true, queued: true });
});

// The dashboard polls this endpoint while IR Automatic Scan is enabled.
app.get('/api/ir-trigger', (_req, res) => {
  const detected = irTriggerPending;
  irTriggerPending = false;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ detected });
});

// Calls Gemini and retries when Google reports temporary overload (503) or a network hiccup.
async function callGemini(body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const MAX_ATTEMPTS = 4;
  let response, data;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body,
      });
      data = await response.json().catch(() => ({}));
      if (response.status !== 503) return { response, data };
      console.warn(`Gemini 503 (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      console.warn(`Gemini network error (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  return { response, data };
}

app.post('/api/classify', async (req, res) => {
  const image = req.body && req.body.image;
  const match = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image. Please capture a JPEG image from the camera and try again.' });
  if (Buffer.byteLength(image, 'utf8') > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Image is too large. Please move closer or try again (maximum 4 MB).' });
  if (!API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is missing from the backend environment settings.' });

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const imageData = match[2];
  try {
    const { response, data } = await callGemini(JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageData } }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: 'application/json' },
    }));
    if (!response.ok) {
      const detail = data.error && data.error.message ? data.error.message : `Gemini returned HTTP ${response.status}`;
      console.error('Gemini API error:', response.status, detail);
      if (response.status === 429) return res.status(429).json({ error: 'Gemini rate limit or quota reached. Wait a little and try again.' });
      if (response.status === 404) return res.status(502).json({ error: 'Gemini model not found. Update the GEMINI_MODEL setting on the backend.' });
      if (response.status === 400 || response.status === 403 || response.status === 401) return res.status(502).json({ error: 'Gemini rejected the request. Check your API key, model name, and API quota in Google AI Studio.' });
      if (response.status === 503) return res.status(503).json({ error: 'Gemini is busy right now. Please wait a few seconds and try again.' });
      return res.status(502).json({ error: 'Gemini service is temporarily unavailable. Please try again.' });
    }
    const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]); }
    let material = String(parsed.material || '').toUpperCase().trim();
    if (!MATERIALS.includes(material)) material = 'UNKNOWN';
    const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
    res.json({
      material,
      confidence: material === 'UNKNOWN' ? Math.min(confidence, 40) : confidence,
      item: String(parsed.item || 'Unidentified object').slice(0, 80),
      reason: String(parsed.reason || 'Please check the item before sorting.').slice(0, 300),
    });
  } catch (error) {
    console.error('Classification error:', error.message);
    res.status(502).json({ error: 'Could not reach Gemini AI. Check the backend logs and try again.' });
  }
});

app.post('/api/sort', async (req, res) => {
  const material = String(req.body?.material || '').toUpperCase();
  if (!MATERIALS.includes(material)) return res.status(400).json({ error: 'Unknown waste category.' });
  const base = String(process.env.ESP32_URL || '').trim().replace(/\/+$/, '');
  if (!base) return res.json({ ok: true, simulated: true, material, message: `${material} bin selected. ESP32 is in simulation mode; no physical servo was activated.` });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${base}/sort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ material }), signal: controller.signal,
    });
    if (!r.ok) throw new Error(`ESP32 HTTP ${r.status}`);
    res.json({ ok: true, simulated: false, material, message: `ESP32 received ${material}.` });
  } catch (error) {
    console.error('ESP32 request failed:', error.message);
    res.status(504).json({ error: 'ESP32 could not be reached. Check its network connection and ESP32_URL.' });
  } finally { clearTimeout(timeout); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`VERDIX API running on port ${PORT}`));
