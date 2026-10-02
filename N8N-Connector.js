// N8N-Connector.js — user-configurable N8N → Kitten → Google Space reporting (v2.10.0).
//
// Any N8N workflow that should report somewhere can call the Kitten instead:
//
//   N8N (HTTP node)  --POST-->  https://<kitten>/n8n/<connector-code>  --> Google Space
//
// Connections live in ONE central Google Sheet (IT + service account only,
// NEVER shared with regular users). Tab "CONNECTIONS", columns A–G:
//
//   A code        — the connector code. Created FIRST by IT (🛠️ Admin →
//                   Generate connector code) and handed to the requester.
//                   It is the setup permission AND the auth token of every
//                   incoming call. Single-use: one code = one connection.
//   B n8n_link    — the N8N workflow URL the user entered (reference only —
//                   the Kitten never calls it).
//   C space_id    — the Google Chat space the reports go to ("spaces/XXXX").
//                   A non-empty C marks the code as CLAIMED.
//   D user_email  — who established the connection (audit).
//   E created     — when (ISO date, audit).
//   F name        — display name, shown in the dialog and as message header.
//   G status      — 'active' or 'revoked'. The Kitten NEVER deletes rows;
//                   revoking (user dialog or IT clearing the cell) keeps the
//                   audit trail. IT can also simply delete the row.
//
// Env: N8N_SHEET_ID (the sheet's ID) + the usual service-account credentials.
// Security model: the code exists in the sheet BEFORE any user can connect
// (shared out-of-band by IT), the sheet is unreadable for users, and incoming
// posts only ever go to the space stored at setup time — a caller can never
// redirect reports somewhere else.

const crypto = require('crypto');
const { getSheetsClient } = require('./GoogleSheet-Handler');
const { postMessageToSpace } = require('./Chat-Poster');

const TAB = 'CONNECTIONS';
const CACHE_MS = 60 * 1000;          // same freshness rule as the FAQ sheet
const TEXT_MAX = 4000;               // cap per incoming message
const TITLE_MAX = 150;
const RATE_MAX = 20;                 // max incoming posts per code...
const RATE_WINDOW_MS = 60 * 1000;    // ...per minute (a looping flow can't flood a space)

function isConfigured() {
  return !!process.env.N8N_SHEET_ID;
}

// ---- sheet access (cached like FAQ-DB) ----
let cache = { rows: null, at: 0 };

function bustCache() { cache = { rows: null, at: 0 }; }

// rows: [{ row, code, link, spaceId, email, created, name, status }]
async function loadConnections(fresh = false) {
  if (!isConfigured()) throw new Error('N8N_SHEET_ID not set in env');
  if (!fresh && cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;

  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.N8N_SHEET_ID,
    range: `${TAB}!A2:G`
  });
  const rows = (res.data.values || []).map((v, i) => ({
    row: i + 2,
    code: (v[0] || '').trim(),
    link: (v[1] || '').trim(),
    spaceId: (v[2] || '').trim(),
    email: (v[3] || '').trim().toLowerCase(),
    created: (v[4] || '').trim(),
    name: (v[5] || '').trim(),
    status: (v[6] || '').trim().toLowerCase()
  })).filter(r => r.code);
  cache = { rows, at: Date.now() };
  return rows;
}

// This user's active connections (for the "Existing connections" tab)
async function listUserConnections(email) {
  if (!email) return [];
  const rows = await loadConnections();
  return rows.filter(r => r.email === email.toLowerCase() && r.spaceId && r.status === 'active');
}

// ---- setup: claim a code ----
// Returns 'bad_code' | 'claimed' | {row, ...} on success.
async function claimCode({ code, link, spaceId, email, name }) {
  const rows = await loadConnections(true); // fresh — never claim on stale data
  const hit = rows.find(r => r.code === code);
  if (!hit || hit.status === 'revoked') return 'bad_code';
  if (hit.spaceId) return 'claimed';        // single-use: already bound

  const created = new Date().toISOString().slice(0, 10);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.N8N_SHEET_ID,
    range: `${TAB}!B${hit.row}:G${hit.row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[link, spaceId, email.toLowerCase(), created, name, 'active']] }
  });
  bustCache();
  return { row: hit.row, code, link, spaceId, email, created, name };
}

// ---- revoke (user dialog) — marks the row, never deletes it ----
// Returns true when the row was this user's active connection.
async function revokeByRow(row, email) {
  const rows = await loadConnections(true);
  const hit = rows.find(r => r.row === Number(row));
  if (!hit || hit.email !== (email || '').toLowerCase() || hit.status !== 'active') return false;

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.N8N_SHEET_ID,
    range: `${TAB}!G${hit.row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['revoked']] }
  });
  bustCache();
  return true;
}

// ---- admin: generate a fresh, unclaimed code ----
async function generateCode() {
  const code = 'N8N-' + crypto.randomBytes(12).toString('hex');
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.N8N_SHEET_ID,
    range: `${TAB}!A:G`,
    valueInputOption: 'RAW',
    requestBody: { values: [[code, '', '', '', '', '', '']] }
  });
  bustCache();
  return code;
}

// The inbound URL an N8N workflow must call for a given code.
// CHAT_APP_AUDIENCE is the public /chat URL — the base is everything before it.
function inboundUrl(code) {
  const base = (process.env.CHAT_APP_AUDIENCE || '').replace(/\/chat\/?$/, '');
  return `${base}/n8n/${code}`;
}

// ---- incoming webhook ----
// Body: JSON { "title": "optional", "text": "required" } — or a plain string.
// Per-code rate limit lives in RAM (a restart just resets the window).
const rateMap = new Map(); // code -> { count, windowStart }

function rateLimited(code) {
  const now = Date.now();
  const r = rateMap.get(code);
  if (!r || now - r.windowStart > RATE_WINDOW_MS) {
    rateMap.set(code, { count: 1, windowStart: now });
    return false;
  }
  r.count += 1;
  return r.count > RATE_MAX;
}

// Returns { status, text } for the HTTP response. Unknown/revoked/unclaimed
// codes all answer a plain 404 — no hints for guessers.
async function handleIncoming(code, body) {
  if (!isConfigured()) return { status: 404, text: 'Not found' };

  let conn;
  try {
    const rows = await loadConnections();
    conn = rows.find(r => r.code === code && r.spaceId && r.status === 'active');
  } catch (err) {
    console.error('❌ N8N inbound: sheet read failed:', err.message);
    return { status: 503, text: 'Temporarily unavailable' };
  }
  if (!conn) return { status: 404, text: 'Not found' };
  if (rateLimited(code)) return { status: 429, text: 'Too many requests — max 20/minute per connection' };

  let title = '', text = '';
  if (typeof body === 'string') {
    text = body;
  } else if (body && typeof body === 'object') {
    title = String(body.title ?? '').trim();
    text = String(body.text ?? body.message ?? '').trim();
  }
  if (!text) return { status: 400, text: 'Missing "text" — send JSON {"title":"...","text":"..."} or a plain text body' };
  title = title.slice(0, TITLE_MAX);
  text = text.slice(0, TEXT_MAX);

  const message = {
    text: `🔌 ${conn.name}${title ? ` — ${title}` : ''}: ${text}`.slice(0, TEXT_MAX),
    cardsV2: [{
      cardId: 'n8n_report',
      card: {
        header: { title: `🔌 ${conn.name}`, subtitle: 'automated report via N8N' },
        sections: [{
          widgets: [
            ...(title ? [{ textParagraph: { text: `<b>${title}</b>` } }] : []),
            { textParagraph: { text } }
          ]
        }]
      }
    }]
  };

  try {
    await postMessageToSpace(conn.spaceId, message);
  } catch (err) {
    console.error(`❌ N8N inbound: post to ${conn.spaceId} failed:`, err.message);
    return { status: 502, text: 'Could not deliver to the space — is the Kitten still a member?' };
  }
  console.log(`🔌 N8N report delivered: "${conn.name}" → ${conn.spaceId}`);
  return { status: 200, text: 'OK — delivered 🐾' };
}

module.exports = {
  isConfigured,
  listUserConnections,
  claimCode,
  revokeByRow,
  generateCode,
  inboundUrl,
  handleIncoming
};
