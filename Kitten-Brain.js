// Kitten-Brain.js — per-user PRIVATE memory ("Kitten Brain").
//
// Each user gets a folder "Kitten Brain" with a Google Sheet "IT Kitten Brain"
// and a README.txt — created IN THE USER'S OWN DRIVE and OWNED BY THE USER.
//
// Privacy model:
//  - Files are created via domain-wide delegation impersonating THE USER with
//    the narrow scope drive.file: the Kitten can only ever access files it
//    created itself — it cannot see anything else in anyone's Drive.
//  - Memory rows are only ever read for the user the current chat event
//    belongs to (keyed by their verified Google identity), so one user's
//    memories can never appear in another user's conversation.
//  - A central registry (BRAIN_REGISTRY tab in SPREADSHEET_ID) stores ONLY
//    file IDs per email — never memory content — so the feature survives
//    renames (access is by ID). Deleting the files breaks it, hence the README.
//
// Required setup (one-time, Admin Console → Security → API controls →
// Domain-wide delegation → edit the existing client ID):
//   add scope  https://www.googleapis.com/auth/drive.file
// and in the GCP project: ENABLE the "Google Drive API".
//
// Env: GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY (same SA), SPREADSHEET_ID.

const { google } = require('googleapis');
const { getSheetsClient } = require('./GoogleSheet-Handler');

const REGISTRY_TAB = 'BRAIN_REGISTRY';
const MEMORY_CACHE_MS = 60 * 1000;
const MAX_MEMORIES_CHARS = 4000; // cap what we inject into Gemini

// ---- impersonated clients (per user, cached) ----
const userClients = new Map(); // email -> { drive, sheets }

function getUserClients(email) {
  if (userClients.has(email)) return userClients.get(email);
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    subject: email // act AS the user — files belong to them
  });
  const c = {
    drive: google.drive({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth })
  };
  userClients.set(email, c);
  return c;
}

// ---- central registry: email -> {folderId, sheetId} (IDs only!) ----
let registryCache = null; // Map email -> entry
let registryLoadedAt = 0;

async function ensureRegistryTab() {
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: REGISTRY_TAB } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${REGISTRY_TAB}!A1:D1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Email', 'Folder ID', 'Sheet ID', 'Created']] }
    });
    console.log('🧠 Created BRAIN_REGISTRY tab.');
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
}

async function loadRegistry(force = false) {
  if (registryCache && !force && Date.now() - registryLoadedAt < 5 * 60 * 1000) return registryCache;
  const sheets = getSheetsClient();
  const map = new Map();
  try {
    // Read from row 1 and filter for real email rows — this way the lookup
    // works no matter whether a header row exists or an entry landed in row 1.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${REGISTRY_TAB}!A1:D`
    });
    for (const row of res.data.values || []) {
      const [email, folderId, sheetId] = row;
      if (email && email.includes('@') && sheetId) map.set(email.toLowerCase(), { folderId, sheetId });
    }
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) {
      await ensureRegistryTab();
    } else {
      throw err;
    }
  }
  registryCache = map;
  registryLoadedAt = Date.now();
  return map;
}

async function registerBrain(email, folderId, sheetId) {
  await ensureRegistryTab();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${REGISTRY_TAB}!A:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[email.toLowerCase(), folderId, sheetId, new Date().toISOString()]] }
  });
  (await loadRegistry(true));
}

async function getBrain(email) {
  const reg = await loadRegistry();
  return reg.get((email || '').toLowerCase()) || null;
}

// ---- creation ----
const README_TEXT = [
  'IT KITTEN BRAIN 🧠',
  '',
  'This folder and the spreadsheet "IT Kitten Brain" belong to the IT Kitten',
  'chat assistant. The sheet stores the personal notes you asked the Kitten to',
  'remember (chat message starting with "remember ...").',
  '',
  'PRIVACY: These files live in YOUR Drive and belong to YOU. The Kitten can',
  'only access files it created itself — nothing else in your Drive. Your notes',
  'are only ever used in YOUR OWN conversations with the Kitten, never in',
  'anyone else\'s, and they are not used to train any AI model.',
  '',
  'IMPORTANT: Please do NOT delete this folder or the spreadsheet if you want',
  'to keep the memory feature working. You may read and edit the sheet freely —',
  'remove rows you no longer want the Kitten to know.',
  '',
  'Questions? Ask the Kitten — or the USC IT team.'
].join('\n');

// Creates the brain for a user (or returns the existing one).
// A per-user in-flight lock makes double/parallel clicks share ONE creation —
// no duplicate folders, no matter how often the button is clicked.
// Returns { created: boolean, folderId, sheetId, folderUrl, sheetUrl }
const creating = new Map(); // email -> Promise

function createBrain(email) {
  const key = (email || '').toLowerCase();
  if (creating.has(key)) return creating.get(key);
  const p = createBrainInner(email).finally(() => creating.delete(key));
  creating.set(key, p);
  return p;
}

async function createBrainInner(email) {
  // force-refresh the registry so a just-created brain is always found
  await loadRegistry(true).catch(() => null);
  const existing = await getBrain(email);
  if (existing) {
    return {
      created: false,
      ...existing,
      folderUrl: `https://drive.google.com/drive/folders/${existing.folderId}`,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${existing.sheetId}`
    };
  }

  const { drive, sheets } = getUserClients(email);

  // 1) folder
  const folder = await drive.files.create({
    requestBody: { name: 'Kitten Brain', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  const folderId = folder.data.id;

  // 2) spreadsheet inside the folder
  const sheetFile = await drive.files.create({
    requestBody: {
      name: 'IT Kitten Brain',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId]
    },
    fields: 'id'
  });
  const sheetId = sheetFile.data.id;

  // header row
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'A1:B1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Date', 'Memory']] }
  });

  // 3) README
  await drive.files.create({
    requestBody: { name: 'README.txt', parents: [folderId] },
    media: { mimeType: 'text/plain', body: README_TEXT },
    fields: 'id'
  });

  await registerBrain(email, folderId, sheetId);
  console.log(`🧠 Kitten Brain created for ${email} (sheet ${sheetId})`);

  return {
    created: true,
    folderId,
    sheetId,
    folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`
  };
}

// ---- remember ----
// Returns 'stored' | 'no_brain'
async function rememberFact(email, fact) {
  const brain = await getBrain(email);
  if (!brain) return 'no_brain';
  const { sheets } = getUserClients(email);
  await sheets.spreadsheets.values.append({
    spreadsheetId: brain.sheetId,
    range: 'A:B',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[new Date().toISOString().slice(0, 10), fact]] }
  });
  memoryCache.delete((email || '').toLowerCase());
  console.log(`🧠 Memory stored for ${email}: "${fact.slice(0, 60)}"`);
  return 'stored';
}

// ---- recall (for Gemini context) ----
const memoryCache = new Map(); // email -> { ts, list }

// Returns an array of memory strings for THIS user only ([] when no brain).
async function getMemories(email) {
  const key = (email || '').toLowerCase();
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.ts < MEMORY_CACHE_MS) return hit.list;

  const brain = await getBrain(email);
  if (!brain) { memoryCache.set(key, { ts: Date.now(), list: [] }); return []; }

  try {
    const { sheets } = getUserClients(email);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: brain.sheetId,
      range: 'A2:B'
    });
    let total = 0;
    const list = [];
    for (const row of res.data.values || []) {
      const line = `${row[0] || ''}: ${(row[1] || '').trim()}`.trim();
      if (!row[1]) continue;
      if (total + line.length > MAX_MEMORIES_CHARS) break;
      list.push(line);
      total += line.length;
    }
    memoryCache.set(key, { ts: Date.now(), list });
    return list;
  } catch (err) {
    console.warn(`⚠️ Kitten Brain read failed for ${email}: ${err.message}`);
    return [];
  }
}

// ---- per-user SETTINGS (stored in a separate tab of the user's own brain
// sheet, so they never interfere with the memories in the first tab) ----
const SETTINGS_TAB = 'SETTINGS';
const SETTING_DEFAULTS = {
  reminders_enabled: true,  // master switch for proactive reminders
  daily_tasks: false,       // "tasks due today" DM (opt-in)
  morning_brief: false,     // morning day-brief: today's meetings (opt-in)
  task_create: true,        // "create me a task ..." via chat (opt-out)
  digest_hour: 8            // hour (Berlin time) for the daily DM
};
const settingsCache = new Map(); // email -> { ts, values }

async function ensureSettingsTab(email, sheetId) {
  const { sheets } = getUserClients(email);
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SETTINGS_TAB } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SETTINGS_TAB}!A1:B1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Setting', 'Value']] }
    });
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
}

// Returns the user's settings (defaults when no brain / tab / row exists).
async function getSettings(email) {
  const key = (email || '').toLowerCase();
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.ts < MEMORY_CACHE_MS) return hit.values;

  const values = { ...SETTING_DEFAULTS };
  const brain = await getBrain(email);
  if (brain) {
    try {
      const { sheets } = getUserClients(email);
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: brain.sheetId,
        range: `${SETTINGS_TAB}!A2:B10`
      });
      for (const row of res.data.values || []) {
        const [k, v] = row;
        if (!k || !Object.prototype.hasOwnProperty.call(values, k)) continue;
        if (k === 'digest_hour') {
          const h = parseInt(v, 10);
          if (!Number.isNaN(h) && h >= 0 && h <= 23) values.digest_hour = h;
        } else {
          values[k] = String(v).toUpperCase() === 'TRUE';
        }
      }
    } catch (err) {
      if (!/Unable to parse range/i.test(err.message)) {
        console.warn(`⚠️ settings read failed for ${email}: ${err.message}`);
      }
      // tab doesn't exist yet → defaults
    }
  }
  settingsCache.set(key, { ts: Date.now(), values });
  return values;
}

// Saves the user's settings. Requires an existing brain ('no_brain' otherwise).
async function setSettings(email, newValues) {
  const brain = await getBrain(email);
  if (!brain) return 'no_brain';
  await ensureSettingsTab(email, brain.sheetId);
  const { sheets } = getUserClients(email);
  const values = { ...SETTING_DEFAULTS, ...newValues };
  await sheets.spreadsheets.values.update({
    spreadsheetId: brain.sheetId,
    range: `${SETTINGS_TAB}!A2:B6`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        ['reminders_enabled', values.reminders_enabled ? 'TRUE' : 'FALSE'],
        ['daily_tasks', values.daily_tasks ? 'TRUE' : 'FALSE'],
        ['morning_brief', values.morning_brief ? 'TRUE' : 'FALSE'],
        ['task_create', values.task_create ? 'TRUE' : 'FALSE'],
        ['digest_hour', String(values.digest_hour)]
      ]
    }
  });
  settingsCache.delete((email || '').toLowerCase());
  console.log(`⚙️ Settings saved for ${email}:`, JSON.stringify(values));
  return 'saved';
}

// All emails that have a Kitten Brain (used by the daily task digest).
async function listBrainEmails() {
  const reg = await loadRegistry();
  return [...reg.keys()];
}

// ---- Kitten admins (tab "Admin access" in the CENTRAL spreadsheet) ----
// One email per row in column A (row 1 is the header). Add/remove admins by
// simply editing the sheet — the Kitten picks it up within 5 minutes.
const ADMIN_TAB = 'Admin access';
let adminCache = null;
let adminLoadedAt = 0;

async function ensureAdminTab() {
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: ADMIN_TAB } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `'${ADMIN_TAB}'!A1:B1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Admin email', 'Added']] }
    });
    console.log('🛠️ Created "Admin access" tab (empty — add admin emails in column A).');
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
}

async function listAdmins(force = false) {
  if (adminCache && !force && Date.now() - adminLoadedAt < 5 * 60 * 1000) return adminCache;
  const sheets = getSheetsClient();
  const set = new Set();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `'${ADMIN_TAB}'!A1:A`
    });
    for (const row of res.data.values || []) {
      const v = (row[0] || '').trim().toLowerCase();
      if (v.includes('@')) set.add(v);
    }
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) {
      await ensureAdminTab(); // first use: create the (empty) tab
    } else {
      throw err;
    }
  }
  adminCache = set;
  adminLoadedAt = Date.now();
  return set;
}

// Is this user a Kitten admin? (drives the 🛠️ Admin menu button)
async function isAdmin(email) {
  const admins = await listAdmins();
  return admins.has((email || '').toLowerCase());
}

module.exports = { createBrain, rememberFact, getMemories, getBrain, getSettings, setSettings, listBrainEmails, isAdmin, listAdmins };
