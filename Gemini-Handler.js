// Gemini-Handler.js — free-text questions answered by Gemini (Vertex AI /
// "Agent Platform"), grounded in the USC IT knowledge base.
//
// Env: VERTEX_PROJECT_ID (enables the feature — unset = feature off),
//      VERTEX_LOCATION (default europe-west1),
//      GEMINI_MODEL (default gemini-2.5-flash),
//      GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY (service account, needs the
//      "Agent Platform user" / roles/aiplatform.user role on the project).
//
// The FAQ knowledge base (FAQ-DB.js, cached 60s) is injected as context into
// every request, so answers point people to the right internal resources.
//
// Since v2.9.0 the model answers STRUCTURED (JSON): the chat answer plus an
// optional TICKET DRAFT (title / description / steps already tried / team)
// built from the conversation — server.js turns that into the "🎫 Open a
// ticket for this" offer with a fully prefilled Jira dialog. The recent
// conversation (server-side, RAM-only) is passed in as `history` so
// follow-ups like "that didn't work" keep their context.

const axios = require('axios');
const { google } = require('googleapis');
const { fetchFAQs } = require('./FAQ-DB');

const LOCATION = process.env.VERTEX_LOCATION || 'europe-west1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_ANSWER_CHARS = 3800;   // Chat text messages cap at ~4096
const MAX_CONTEXT_CHARS = 15000; // keep the FAQ context (and cost) bounded

let jwtClient = null;

function isEnabled() {
  return !!(process.env.VERTEX_PROJECT_ID && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

async function getAccessToken() {
  if (!jwtClient) {
    jwtClient = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
  }
  const res = await jwtClient.getAccessToken();
  return typeof res === 'string' ? res : res.token;
}

// Build the FAQ context block (best effort — Gemini works without it too)
async function buildFaqContext() {
  try {
    const faqs = await fetchFAQs();
    let out = '';
    for (const f of faqs) {
      const line = `- ${f.suggestion}: ${(f.responseText || '').replace(/\s+/g, ' ').slice(0, 300)}\n`;
      if (out.length + line.length > MAX_CONTEXT_CHARS) break;
      out += line;
    }
    return out;
  } catch (err) {
    console.warn('⚠️ Gemini: FAQ context unavailable:', err.message);
    return '';
  }
}

function buildSystemInstruction(faqContext, userName, memories) {
  const memoryBlock = (memories && memories.length)
    ? `\nPRIVATE MEMORY — personal notes THIS user asked you to remember. They are private ` +
      `to this user; use them when relevant to personalize your answer. Never present them ` +
      `as facts about anyone else. If the user asks you to forget, delete or stop remembering ` +
      `one of these memories, explain that you cannot delete memories yourself: they should open ` +
      `the "IT Kitten Brain" sheet in the "Kitten Brain" folder of their own Google Drive and ` +
      `delete that row — you will forget it within a minute:\n${memories.map(m => `- ${m}`).join('\n')}\n`
    : '';
  return buildSystemInstructionBase(faqContext, userName) + memoryBlock;
}

function buildSystemInstructionBase(faqContext, userName) {
  return (
    `You are IT Kitten 🐱, the internal IT assistant of Urban Sports Club (USC), living in Google Chat. ` +
    `You are talking to ${userName || 'a USC employee'}.\n\n` +
    `Rules:\n` +
    `- Be helpful, friendly and CONCISE (chat format, not essays).\n` +
    `- Answer in the language the user writes in.\n` +
    `- Use the internal IT knowledge base below whenever it is relevant, and include its links.\n` +
    `- Never invent internal USC facts, links, passwords or policies that are not in the knowledge base.\n` +
    `- Never reveal passwords. If asked for WiFi passwords, point to the "What is the wifi password?" button in the kitten menu.\n` +
    `- General knowledge and technical questions outside USC you may answer normally.\n` +
    `- FORMATTING for the "answer" field (Google Chat): *bold* with single asterisks, _italic_ with underscores, ` +
    `links as <https://url|link text>, simple "-" lists. NO markdown headings, NO tables, NO ** double asterisks.\n\n` +
    `OUTPUT FORMAT — you respond ONLY with one JSON object, nothing else:\n` +
    `{"answer": string, "offer_ticket": boolean, "ticket": {"title": string, "description": string, "steps_tried": string, "team": string}}\n\n` +
    `TICKET OFFERS ("offer_ticket") — HELP FIRST, ticket second. You are first-level IT support: many ` +
    `problems are solved right here in the chat, so your FIRST reaction to a newly described problem is ` +
    `NEVER a ticket. When the user first mentions an issue, give your best concrete troubleshooting steps ` +
    `(and ask ONE short clarifying question if you need it) and set "offer_ticket": false. ` +
    `Set "offer_ticket": true ONLY when at least one of these applies:\n` +
    `a) the user EXPLICITLY asks to create/open a ticket,\n` +
    `b) the conversation shows the suggested fixes were already tried and did NOT work,\n` +
    `c) the problem clearly cannot be fixed by the user themselves — e.g. defective/broken hardware needing ` +
    `repair or replacement, access/permissions/licenses only a team can grant, or a security incident ` +
    `(offer immediately in these cases),\n` +
    `d) you truly have no troubleshooting steps to offer.\n` +
    `When true, also build "ticket" FROM THE CONVERSATION:\n` +
    `- "title": one short, precise ticket title (max 90 characters).\n` +
    `- "description": the issue in clear, complete sentences (device, what happens, impact). Only facts the ` +
    `user actually gave — never invent details.\n` +
    `- "steps_tried": what was already suggested or tried WITHOUT success in this conversation, as short "-" ` +
    `lines; "None yet" if nothing was tried.\n` +
    `- "team": exactly one of "IH" (IT Helpdesk — the default for general IT), "SECHELP" (security incidents, ` +
    `phishing, compromised accounts), "SRE" (platform/infrastructure engineering), "DX" (developer tooling).\n` +
    `When offering a ticket, end your "answer" by mentioning they can use the button below to open a ` +
    `prefilled ticket — or, if they prefer, create one themselves at ` +
    `<https://urbansportsclub.atlassian.net/servicedesk/customer/portal/3|IT Service Desk>.\n\n` +
    (faqContext ? `Internal IT knowledge base (title: answer):\n${faqContext}` : '')
  );
}

// Parse the model's JSON (tolerates ```json fences). Falls back to treating
// the whole text as a plain answer if parsing fails — never breaks the chat.
function parseStructured(raw) {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const obj = JSON.parse(cleaned);
    if (typeof obj.answer !== 'string' || !obj.answer.trim()) throw new Error('no answer field');
    let ticket = null;
    if (obj.offer_ticket && obj.ticket && typeof obj.ticket.title === 'string' && obj.ticket.title.trim()) {
      const t = obj.ticket;
      ticket = {
        title: String(t.title).slice(0, 150),
        description: String(t.description || '').slice(0, 4000),
        steps_tried: String(t.steps_tried || 'None yet').slice(0, 2000),
        team: ['IH', 'SRE', 'DX', 'SECHELP'].includes(t.team) ? t.team : 'IH'
      };
    }
    return { answer: obj.answer.trim(), ticket };
  } catch (err) {
    console.warn('⚠️ Gemini JSON parse failed — using raw text as answer:', err.message);
    return { answer: raw.trim(), ticket: null };
  }
}

// Ask Gemini. `history` = recent conversation turns of THIS user
// ([{ role: 'user'|'model', text }], RAM-only, provided by server.js).
// Returns { answer, ticket } — ticket is null or the draft for the
// "🎫 Open a ticket for this" offer. Returns null when the feature is
// disabled. Throws on API errors (caller decides the fallback message).
async function askKitten({ question, userName, memories = [], history = [] }) {
  if (!isEnabled()) return null;

  const [token, faqContext] = await Promise.all([getAccessToken(), buildFaqContext()]);

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${process.env.VERTEX_PROJECT_ID}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  // recent conversation first, current question last
  const contents = [
    ...history.map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: question }] }
  ];

  const body = {
    systemInstruction: { parts: [{ text: buildSystemInstruction(faqContext, userName, memories) }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 1536, responseMimeType: 'application/json' }
  };

  const res = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 25000 // Chat expects our HTTP response within ~30s
  });

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  const raw = parts.map(p => p.text || '').join('').trim();

  if (!raw) {
    const reason = res.data?.candidates?.[0]?.finishReason || 'no content';
    throw new Error(`Gemini returned no text (${reason})`);
  }

  const { answer, ticket } = parseStructured(raw);
  const trimmed = answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS - 2) + ' …' : answer;
  return { answer: trimmed, ticket };
}

module.exports = { askKitten, isEnabled };
