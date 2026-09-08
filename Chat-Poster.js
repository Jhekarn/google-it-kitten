// Chat-Poster.js — PROACTIVE messages via the Google Chat REST API.
// Everything else in this bot only ANSWERS events; the cron jobs need to
// speak first (post reports into a space, DM users). That works through the
// Chat API with our service account (app auth, chat.bot scope).
//
// Requirements:
//  - The IT Kitten app must be a member of any space it posts into.
//  - DMs only work if the user already has a DM with the app (they opened it
//    at least once). Otherwise sendDm() returns false and callers use the fallback.
//
// Env: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY (same service account as Sheets)

const { google } = require('googleapis');

let chatClient = null;

function getChatClient() {
  if (chatClient) return chatClient;

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY not set in env');

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/chat.bot']
  });

  chatClient = google.chat({ version: 'v1', auth });
  return chatClient;
}

// Post a text message into a space ("spaces/XXXX").
// Chat text supports *bold*, _italic_ and <https://url|Label> links.
async function postToSpace(spaceId, text) {
  const chat = getChatClient();
  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: { text }
  });
}

// Find the existing DM space between the app and a user (by email).
async function findDmSpace(email) {
  const chat = getChatClient();
  const res = await chat.spaces.findDirectMessage({ name: `users/${email}` });
  return res.data?.name || null;
}

// DM a user by email. Returns true on success, false if no DM space exists.
async function sendDm(email, text) {
  try {
    const dmSpace = await findDmSpace(email);
    if (!dmSpace) return false;
    await postToSpace(dmSpace, text);
    return true;
  } catch (err) {
    console.warn(`⚠️ Could not DM ${email}: ${err.message}`);
    return false;
  }
}

// Ops/error notifications: post into FALLBACK_SPACE_ID (falls back to
// REPORT_SPACE_ID if unset). Never throws — logging errors must not kill jobs.
async function postOps(text) {
  const spaceId = process.env.FALLBACK_SPACE_ID || process.env.REPORT_SPACE_ID;
  if (!spaceId) {
    console.warn('⚠️ postOps: no FALLBACK_SPACE_ID/REPORT_SPACE_ID set —', text);
    return;
  }
  try {
    await postToSpace(spaceId, text);
  } catch (err) {
    console.error('⚠️ postOps failed:', err.message, '—', text);
  }
}

module.exports = { postToSpace, sendDm, findDmSpace, postOps };
