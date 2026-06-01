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
  hms: `You are a subject validator for HSC Health and Movement Science (HMS) exam questions (NSW NESA 2023 syllabus).

Reply with only the word true if the question relates to HMS, or false if it does not. No other text.

Year 11 — Health for individuals and communities: meanings and measures of health (WHO definition, health continuum, dynamic nature of health), epidemiology, mortality, infant mortality, morbidity, incidence, prevalence, social determinants of health, health inequities, young people's health issues, health literacy, self-efficacy, help-seeking behaviours, resilience, Ottawa Charter, health promotion approaches (biomedical, sociocultural, salutogenic, ecological models), Aboriginal and Torres Strait Islander health, government and non-government organisations (ACYP, NACCHO, CYDA), UN Sustainable Development Goals (SDGs), UNESCO, WHO, influence of technology and global events on young people's health.

Year 11 — The body and mind in motion: skeletal system (bones, synovial joints, joint actions — flexion, extension), muscular system (slow/fast twitch muscle fibres, isotonic/isometric contractions, agonist/antagonist/stabiliser), biomechanical principles (motion, balance, stability, fluid mechanics, force), respiratory system, circulatory system (pulmonary and systemic circulation, gaseous exchange, cardiac output, stroke volume), digestive and endocrine systems, nervous system, energy systems (ATP-PCr, glycolytic/lactic acid, aerobic — fuel sources, fatigue, interplay), nutrition (macronutrients, micronutrients), training methods (aerobic, anaerobic, HIIT, SIT, continuous, interval), FITT principle, physiological responses to training, fitness testing, skill acquisition (cognitive/associative/autonomous stages, massed/distributed/whole/part practice, feedback types), sport psychology (motivation, self-regulation, personal identity), contemporary exercise forms, group dynamics, first aid.

Year 12 — Health in an Australian and global context: health status of Australians (morbidity, mortality, life expectancy), health inequities (Aboriginal and Torres Strait Islander Peoples, socioeconomic disadvantage, rural/remote, culturally and linguistically diverse, disability, older people), OECD health comparisons, cardiovascular disease, cancer, ageing population, Australia's healthcare system, Medicare, NDIS, My Aged Care, private health insurance, complementary healthcare, health apps and websites, critical health consumer, technology and health (relationship between technology and health, measuring and monitoring health, early diagnosis, precision surgery, new technologies and treatments), digital health (what is digital health, services, challenges and opportunities), artificial intelligence in healthcare, assistive technology, big data (reducing healthcare spending, curing and managing diseases, privacy and confidentiality), Sustainable Development Goals (SDGs 3, 4, 10, 11).

Year 12 — Training for improved performance: pre-exercise questionnaire, health screening, fitness testing (Yo-yo test, Wingate test), training types (anaerobic interval, HIIT, SIT, plyometric, resistance, continuous, fartlek, aerobic interval, circuit, flexibility — static/dynamic/ballistic/PNF, strength training), principles of training (progressive overload, training thresholds, reversibility, specificity, variety, warm-up/cool-down), physiological adaptations (heart rate, stroke volume, cardiac output, oxygen uptake, lung capacity, haemoglobin, muscle hypertrophy, fast/slow twitch fibres), individual and group sports training programs, periodisation (pre-season, in-season, off-season, peaking, tapering), psychological strategies (arousal, stress and anxiety management), sleep, nutrition and hydration for performance, supplements (caffeine, creatine, protein, micronutrients), biomechanics for efficient and sustained movement, recovery strategies (cool-down, hydrotherapy, relaxation), technology in performance (training innovations, equipment advances, recording and monitoring training and performance), injury management (TOTAPS, classification of injuries — direct/indirect/soft/hard tissue/overuse, rehabilitation — progressive mobilisation, graduated exercise, heat and cold, return-to-play policy), drug use (health implications, ethical considerations, drug testing, WADA, anti-doping).`,
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
    'Access-Control-Allow-Origin': 'https://app.commandohsc.com',
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
    const userMessage = `HSC exam question: ${question.trim().slice(0, 500)}`;
    const result = await callHaiku(SUBJECT_SYSTEM_PROMPTS[subject], userMessage);
    // Only block if Haiku explicitly says "false" — any other response allows through
    const text = (result?.content?.[0]?.text || '').trim().toLowerCase();
    // Only block if the response is exactly "false" — any other response allows through
    const relevant = text !== 'false';
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relevant }),
    };
  } catch (err) {
    console.error('check-subject error:', err.message);
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relevant: true }),
    };
  }
};
