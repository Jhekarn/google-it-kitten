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

function buildSystemInstruction(faqContext, userName) {
  return (
    `You are IT Kitten 🐱, the internal IT assistant of Urban Sports Club (USC), living in Google Chat. ` +
    `You are talking to ${userName || 'a USC employee'}.\n\n` +
    `Rules:\n` +
    `- Be helpful, friendly and CONCISE (chat format, not essays).\n` +
    `- Answer in the language the user writes in.\n` +
    `- Use the internal IT knowledge base below whenever it is relevant, and include its links.\n` +
    `- Never invent internal USC facts, links, passwords or policies that are not in the knowledge base. ` +
    `For internal questions you cannot answer, say so and suggest creating a ticket: the user can type "kitten" ` +
    `and click "Create a Jira Ticket" in the menu.\n` +
    `- Never reveal passwords. If asked for WiFi passwords, point to the "What is the wifi password?" button in the kitten menu.\n` +
    `- General knowledge and technical questions outside USC you may answer normally.\n` +
    `- FORMATTING for Google Chat: *bold* with single asterisks, _italic_ with underscores, ` +
    `links as <https://url|link text>, simple "-" lists. NO markdown headings, NO tables, NO ** double asterisks.\n\n` +
    (faqContext ? `Internal IT knowledge base (title: answer):\n${faqContext}` : '')
  );
}

// Ask Gemini. Returns the answer text, or null when the feature is disabled.
// Throws on API errors (caller decides the fallback message).
async function askGemini(question, userName) {
  if (!isEnabled()) return null;

  const [token, faqContext] = await Promise.all([getAccessToken(), buildFaqContext()]);

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${process.env.VERTEX_PROJECT_ID}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const body = {
    systemInstruction: { parts: [{ text: buildSystemInstruction(faqContext, userName) }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
  };

  const res = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 25000 // Chat expects our HTTP response within ~30s
  });

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  let answer = parts.map(p => p.text || '').join('').trim();

  if (!answer) {
    const reason = res.data?.candidates?.[0]?.finishReason || 'no content';
    throw new Error(`Gemini returned no text (${reason})`);
  }

  if (answer.length > MAX_ANSWER_CHARS) {
    answer = answer.slice(0, MAX_ANSWER_CHARS - 2) + ' …';
  }
  return answer;
}

module.exports = { askGemini, isEnabled };
