require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MATERIALS = ['PLASTIC', 'METAL', 'ORGANIC', 'OTHER'];
// AI provider: Groq if GROQ_API_KEY is set (or AI_PROVIDER=groq), otherwise Gemini.
const GROQ_KEY = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const PROVIDER = String(process.env.AI_PROVIDER || (GROQ_KEY ? 'groq' : 'gemini')).toLowerCase() === 'groq' ? 'groq' : 'gemini';
const API_KEY = PROVIDER === 'groq' ? GROQ_KEY : GEMINI_KEY;
const KEY_NAME = PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'GEMINI_API_KEY';
const LABEL = PROVIDER === 'groq' ? 'Groq' : 'Gemini';
const MODEL = PROVIDER === 'groq'
  ? (process.env.GROQ_MODEL || 'qwen/qwen3.8-27b')
  : (process.env.GEMINI_MODEL || 'gemini-3.8-flash');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ORIGINS = (process.env.FRONTEND_URL || '*').split(',').map(s => s.trim().replace(/\/+$/, ''));
let irTriggerPending = false;
let lastIrTriggerAt = 0;
const IR_DEBOUNCE_MS = 1500;
// Sort commands waiting for the ESP32 to pick up (ESP32 polls /api/sort-command).
let pendingSort = null;
let lastEspPollAt = 0;
const ESP_ONLINE_MS = 15000;
const SORT_EXPIRE_MS = 30000;
const espOnline = () => Date.now() - lastEspPollAt < ESP_ONLINE_MS;
// Bin fill levels (0-100, percent full) reported by the ESP32 ultrasonic sensors.
let binLevels = {};
let binLevelsAt = 0;
const LEVELS_FRESH_MS = 60000;
const BIN_FULL_PERCENT = Number(process.env.BIN_FULL_PERCENT) || 90;
const freshLevels = () => (Date.now() - binLevelsAt < LEVELS_FRESH_MS ? binLevels : {});

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

const PROMPT = `You are the vision classifier for a waste-sorting prototype. Inspect the image and classify the main visible waste item into exactly one category: PLASTIC, METAL, ORGANIC, or OTHER. PLASTIC means plastic bottles, packaging and containers. METAL means cans, foil and metal scraps. ORGANIC means food scraps or other clearly biodegradable organic waste. OTHER means glass, paper, cardboard, cartons, or any other item that is not plastic, metal or organic. If the image is empty, blurry, has multiple ambiguous items, or cannot be classified reliably, return UNKNOWN. Do not claim laboratory-level certainty. Reply with only valid JSON in this exact shape: {"material":"PLASTIC|METAL|ORGANIC|OTHER|UNKNOWN","confidence":0,"item":"short item name","reason":"one short sentence"}. Confidence is an estimate from 0 to 100.`;

app.get('/health', (_req, res) => res.json({ ok: true, project: 'VERDIX' }));
app.get('/api/status', (_req, res) => res.json({
  ai: Boolean(API_KEY),
  provider: PROVIDER,
  model: MODEL,
  esp32: process.env.ESP32_URL ? 'configured' : (espOnline() ? 'connected' : 'simulation'),
  irTrigger: true,
  bins: freshLevels(),
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

// The ESP32 polls this endpoint to receive the confirmed sort command.
app.get('/api/sort-command', (req, res) => {
  const expected = String(process.env.IR_TRIGGER_TOKEN || '').trim();
  const supplied = String(req.get('x-ir-token') || '').trim();
  if (expected && supplied !== expected) return res.status(401).json({ error: 'Invalid token.' });
  lastEspPollAt = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (pendingSort && Date.now() - pendingSort.at <= SORT_EXPIRE_MS) {
    const material = pendingSort.material;
    pendingSort = null;
    return res.json({ material });
  }
  pendingSort = null;
  res.json({ material: null });
});

// The ESP32 posts bin fill levels here (percent full per bin; null if a sensor failed).
app.post('/api/bin-levels', (req, res) => {
  const expected = String(process.env.IR_TRIGGER_TOKEN || '').trim();
  const supplied = String(req.get('x-ir-token') || '').trim();
  if (expected && supplied !== expected) return res.status(401).json({ error: 'Invalid token.' });
  const levels = {};
  for (const m of MATERIALS) {
    const v = req.body ? req.body[m] : null;
    if (typeof v === 'number' && isFinite(v) && v >= 0) levels[m] = Math.min(100, Math.round(v));
  }
  binLevels = levels;
  binLevelsAt = Date.now();
  res.json({ ok: true });
});

// Retries a provider request on temporary overload (503) or a network hiccup.
async function withRetry(doRequest) {
  const MAX_ATTEMPTS = 4;
  let result;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await doRequest();
      if (result.status !== 503) return result;
      console.warn(`${LABEL} 503 (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      console.warn(`${LABEL} network error (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  return result;
}

async function askGemini(mimeType, imageData) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageData } }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: 'application/json' },
    }),
  });
  const data = await response.json().catch(() => ({}));
  const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  return { status: response.status, ok: response.ok, raw, detail: data.error && data.error.message };
}

async function askGroq(mimeType, imageData) {
  const send = async (withReasoning) => {
    const body = {
      model: MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
      ] }],
      temperature: 0.2,
      max_completion_tokens: 500,
      response_format: { type: 'json_object' },
    };
    if (withReasoning) body.reasoning_effort = 'none';   // instruct mode: fast answer, no long thinking
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    const raw = String(data.choices?.[0]?.message?.content || '').trim();
    return { status: response.status, ok: response.ok, raw, detail: data.error && data.error.message };
  };
  let result = await send(true);
  if (result.status === 400) {   // some models reject reasoning_effort; try once without it
    console.warn('Groq 400 with reasoning_effort, retrying without it:', result.detail);
    result = await send(false);
  }
  return result;
}

app.post('/api/classify', async (req, res) => {
  const image = req.body && req.body.image;
  const match = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image. Please capture a JPEG image from the camera and try again.' });
  if (Buffer.byteLength(image, 'utf8') > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Image is too large. Please move closer or try again (maximum 4 MB).' });
  if (!API_KEY) return res.status(500).json({ error: `${KEY_NAME} is missing from the backend environment settings.` });

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const imageData = match[2];
  try {
    const result = await withRetry(() => (PROVIDER === 'groq' ? askGroq(mimeType, imageData) : askGemini(mimeType, imageData)));
    if (!result.ok) {
      const detail = result.detail || `${LABEL} returned HTTP ${result.status}`;
      console.error(`${LABEL} API error:`, result.status, detail);
      if (result.status === 429) return res.status(429).json({ error: `${LABEL} rate limit or quota reached. Wait a little and try again.` });
      if (result.status === 404) return res.status(502).json({ error: `${LABEL} model not found. Check the model name setting on the backend.` });
      if ([400, 401, 403].includes(result.status)) return res.status(502).json({ error: `${LABEL} rejected the request. Check your API key, model name, and quota.` });
      if (result.status === 503) return res.status(503).json({ error: `${LABEL} is busy right now. Please wait a few seconds and try again.` });
      return res.status(502).json({ error: `${LABEL} service is temporarily unavailable. Please try again.` });
    }
    const raw = String(result.raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
    res.status(502).json({ error: `Could not reach ${LABEL} AI. Check the backend logs and try again.` });
  }
});

app.post('/api/sort', async (req, res) => {
  const material = String(req.body?.material || '').toUpperCase();
  if (!MATERIALS.includes(material)) return res.status(400).json({ error: 'Unknown waste category.' });
  const level = freshLevels()[material];
  if (typeof level === 'number' && level >= BIN_FULL_PERCENT) {
    return res.status(409).json({ error: `${material[0] + material.slice(1).toLowerCase()} bin is ${level}% full. Empty it before sorting more.` });
  }
  const base = String(process.env.ESP32_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    if (espOnline()) {
      pendingSort = { material, at: Date.now() };
      return res.json({ ok: true, simulated: false, material, message: `${material} command sent. The ESP32 will move the servo within a second.` });
    }
    return res.json({ ok: true, simulated: true, material, message: `${material} bin selected. ESP32 is not connected; no physical servo was activated.` });
  }
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
