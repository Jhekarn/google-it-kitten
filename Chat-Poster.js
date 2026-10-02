// Chat-Poster.js — PROACTIVE messages via the Google Chat REST API.
// Everything else in this bot only ANSWERS events; the cron jobs need to
// speak first (post reports into a space, DM users). That works through the
// Chat API with our service account (app auth, chat.bot scope).
//
// Requirements:
//  - The IT Kitten app must be a member of any space it posts into.
//  - DMs only work if the user already has a DM with the app (they opened it
//    at least once). Otherwise sendDm() throws and callers use the fallback.
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

// Post a FULL message object (text + cardsV2) into a space — used by the
// N8N connector (v2.10.0) so automated reports arrive as a tidy card.
async function postMessageToSpace(spaceId, message) {
  const chat = getChatClient();
  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: message
  });
}

// List the SPACES the Kitten is a member of (no DMs) — feeds the space
// dropdown of the N8N setup dialog. Paginated; returns [{ id, label }].
async function listKittenSpaces() {
  const chat = getChatClient();
  const spaces = [];
  let pageToken;
  do {
    const res = await chat.spaces.list({
      pageSize: 100,
      pageToken,
      filter: 'space_type = "SPACE"'
    });
    for (const s of res.data?.spaces || []) {
      spaces.push({ id: s.name, label: s.displayName || s.name });
    }
    pageToken = res.data?.nextPageToken;
  } while (pageToken);
  spaces.sort((a, b) => a.label.localeCompare(b.label));
  return spaces;
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

// Fetch one user's Directory profile (id + names). Returns null when
// delegation is not configured or the lookup fails.
async function getUserInfo(emailAddr) {
  const dir = getDirectoryClient();
  if (!dir) return null;
  try {
    const res = await dir.users.get({
      userKey: emailAddr,
      fields: 'id,primaryEmail,name/givenName,name/fullName'
    });
    const u = res.data || {};
    if (u.id && u.primaryEmail) userIdCache.set(u.primaryEmail, u.id);
    return {
      id: u.id || null,
      email: u.primaryEmail || emailAddr,
      firstName: u.name?.givenName || '',
      fullName: u.name?.fullName || ''
    };
  } catch (err) {
    console.warn(`⚠️ Directory profile lookup failed for ${emailAddr}: ${err.message}`);
    return null;
  }
}

// List ALL active users of the Workspace domain (Directory users.list, paginated).
// Suspended/archived accounts are skipped. Also warms the userIdCache, so the
// subsequent DMs don't need a second Directory call per user.
async function listDomainUsers() {
  const dir = getDirectoryClient();
  if (!dir) throw new Error('ADMIN_IMPERSONATE_EMAIL not set — Directory access unavailable');

  const users = [];
  let pageToken;
  do {
    const res = await dir.users.list({
      customer: 'my_customer',
      maxResults: 500,
      pageToken,
      fields: 'nextPageToken,users(id,primaryEmail,name/givenName,name/fullName,suspended,archived)'
    });
    for (const u of res.data?.users || []) {
      if (u.suspended || u.archived || !u.primaryEmail) continue;
      users.push({
        id: u.id,
        email: u.primaryEmail,
        firstName: u.name?.givenName || '',
        fullName: u.name?.fullName || ''
      });
      if (u.id) userIdCache.set(u.primaryEmail, u.id);
    }
    pageToken = res.data?.nextPageToken;
  } while (pageToken);

  return users;
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

module.exports = { postToSpace, postMessageToSpace, listKittenSpaces, sendDm, findDmSpace, postOps, getUserInfo, listDomainUsers };
