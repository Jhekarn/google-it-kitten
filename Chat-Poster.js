// Chat-Poster.js — PROACTIVE messages via the Google Chat REST API.
// Everything else in this bot only ANSWERS events; the cron jobs need to
// speak first (post reports into a space, DM users). That works through the
// Chat API with our service account (app auth, chat.bot scope).
//
// Requirements:
//  - The IT Kitten app must be a member of any space it posts into.
//  - DMs need the user's NUMERIC id (app auth can't address users by email):
//    we resolve email → id via the Admin SDK Directory API using domain-wide
//    delegation (ADMIN_IMPERSONATE_EMAIL = a Workspace admin). The user must
//    also have a DM with the app (auto-created by Marketplace admin install).
//
// Env: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, ADMIN_IMPERSONATE_EMAIL,
//      FALLBACK_SPACE_ID / REPORT_SPACE_ID (for postOps)

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

// ---- Directory lookup: email → numeric Google user ID ----
// App auth cannot address Chat users by email, only by users/<numeric id>.
// We resolve the id via the Admin SDK Directory API using domain-wide
// delegation (ADMIN_IMPERSONATE_EMAIL must be a Workspace admin).
let directoryClient = null;

function getDirectoryClient() {
  if (directoryClient) return directoryClient;

  const subject = process.env.ADMIN_IMPERSONATE_EMAIL;
  if (!subject) return null; // delegation not configured → fall back to email

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
    subject
  });

  directoryClient = google.admin({ version: 'directory_v1', auth });
  return directoryClient;
}

const userIdCache = new Map(); // email → numeric id (per process)

async function resolveUserId(emailAddr) {
  if (userIdCache.has(emailAddr)) return userIdCache.get(emailAddr);

  const dir = getDirectoryClient();
  if (!dir) return null;

  try {
    const res = await dir.users.get({ userKey: emailAddr, fields: 'id' });
    const id = res.data?.id || null;
    if (id) userIdCache.set(emailAddr, id);
    return id;
  } catch (err) {
    console.warn(`⚠️ Directory lookup failed for ${emailAddr}: ${err.message}`);
    return null;
  }
}

// Find the existing DM space between the app and a user.
// Uses the numeric user id when resolvable (required for app auth),
// otherwise falls back to the email form.
async function findDmSpace(email) {
  const chat = getChatClient();
  const id = await resolveUserId(email);
  const userName = id ? `users/${id}` : `users/${email}`;
  const res = await chat.spaces.findDirectMessage({ name: userName });
  return res.data?.name || null;
}

// DM a user by email. Returns true on success, false if it can't be delivered.
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

module.exports = { postToSpace, sendDm, findDmSpace, postOps, resolveUserId };
