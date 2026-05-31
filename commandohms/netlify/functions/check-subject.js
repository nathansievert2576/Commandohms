// netlify/functions/check-subject.js
// Checks whether a question relates to a given HMS subject using Claude Haiku.
// Requires a valid Supabase session but does NOT deduct credits.

const https = require('https');

function supabaseRequest({ supabaseUrl, supabaseKey, path, method, token }) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, supabaseUrl);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': token ? `Bearer ${token}` : `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Supabase timeout')); });
    req.end();
  });
}

async function validateToken(token) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const { status, body } = await supabaseRequest({ supabaseUrl, supabaseKey, path: '/auth/v1/user', method: 'GET', token });
    return (status === 200 && body && body.id) ? body : null;
  } catch (e) {
    return null;
  }
}

const SUBJECT_SYSTEM_PROMPTS = {
  hms: `You are a subject validator for HSC Health and Movement Science (HMS) exam questions.

HMS covers: cardiovascular system, respiratory system, musculoskeletal system, energy systems (ATP-PC, glycolytic, aerobic), training principles and methods (fartlek, interval, resistance, plyometric, PNF, periodisation, tapering), nutrition and supplementation for performance, biomechanics, thermoregulation, skill acquisition, sport psychology (motivation, arousal, anxiety, self-efficacy), injury prevention and management (TOTAPS, rehabilitation, return to play), health in Australian and global context (social determinants of health, health promotion, Ottawa Charter, epidemiology, mortality, morbidity, health systems including Medicare and NDIS, organisations like AIHW and WHO, Aboriginal and Torres Strait Islander health, socioeconomic factors), performance enhancement (supplements such as caffeine and creatine, anti-doping, WADA), and fitness testing.

Reply with only the word true if the question relates to HMS, or false if it does not. No other text.`,
};

const ALLOWED_SUBJECTS = new Set(['hms']);

async function callHaiku(systemPrompt, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Anthropic')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Anthropic timeout')); });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorised' }) };

  const user = await validateToken(token);
  if (!user) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorised' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { question, subject } = payload;

  if (!question || typeof question !== 'string' || question.trim().length < 5) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid question' }) };
  }
  if (!subject || !ALLOWED_SUBJECTS.has(subject)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid subject' }) };
  }

  try {
    const result = await callHaiku(SUBJECT_SYSTEM_PROMPTS[subject], question.trim().slice(0, 500));
    const text = (result?.content?.[0]?.text || '').trim().toLowerCase();
    const relevant = text.startsWith('true');
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relevant }),
    };
  } catch (err) {
    console.error('check-subject error:', err.message);
    // On any error, allow the question through — don't block the user
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relevant: true }),
    };
  }
};
