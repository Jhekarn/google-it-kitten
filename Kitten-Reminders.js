// Kitten-Reminders.js — one-off reminders ("remind me in 2 hours to ...").
//
// Storage: CENTRAL spreadsheet (SPREADSHEET_ID), tab REMINDERS:
//   A: Email | B: Due (ISO, UTC) | C: Reminder text | D: Status
//   Status: empty = open · ISO timestamp = sent · "cancelled ..." = cancelled
//           · "failed ..." = DM could not be delivered (not retried)
//
// NOTE: unlike Kitten Brain memories, these rows live in the central sheet so
// ONE read per minute can serve every user (a per-user sheet scan for 500+
// users every minute would blow the Sheets quota). Reminder texts are
// therefore visible to whoever can open the central sheet (= IT). The chat
// confirmation tells users that reminders are stored centrally.
//
// server.js runs checkDueReminders() every minute via cron.

const { getSheetsClient } = require('./GoogleSheet-Handler');
const { sendDm } = require('./Chat-Poster');

const TAB = 'REMINDERS';
const MAX_TEXT = 300;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000; // max 1 year ahead

// ---------- Berlin time helpers (DST-safe) ----------

// Current (or given) moment as Berlin calendar parts.
function berlinParts(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ts));
  const g = t => Number(p.find(x => x.type === t)?.value);
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour') % 24, mm: g('minute') };
}

// "This wall-clock time in Berlin" -> UTC epoch ms (handles DST, day overflow).
function berlinToUtcMs(y, m, d, hh, mm) {
  let ts = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const shown = berlinParts(ts);
    const diff = Date.UTC(y, m - 1, d, hh, mm) -
                 Date.UTC(shown.y, shown.m - 1, shown.d, shown.hh, shown.mm);
    if (!diff) break;
    ts += diff;
  }
  return ts;
}

// "Thu 17/09/2026, 15:00" style Berlin timestamp for user-facing texts.
function fmtBerlin(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms)).replace(',', '');
}

// ---------- parsing ----------

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// Parses a "remind me ..." message. Returns { dueMs, text } or null.
// Supported (times are Berlin time):
//   remind me in 30 minutes to check the deploy
//   remind me in 2 hours ... / in 3 days ...
//   remind me at 15:30 to ... (today; tomorrow if already past)
//   remind me tomorrow [at 9[:30]] to ...
//   remind me on friday [at 14] to ...
//   remind me on 24.12. [at 10] to ... / on 2026-12-24 [at 10] to ...
function parseReminder(raw, nowMs = Date.now()) {
  let s = String(raw || '').trim().replace(/^remind\s+me\b[,:]?\s*/i, '');
  if (!s) return null;
  const now = berlinParts(nowMs);
  const stripLead = t => (t || '').replace(/^(to|that|about|of)\s+/i, '').trim();
  let m;

  // in N minutes/hours/days
  if ((m = s.match(/^in\s+(\d+)\s*(minutes?|mins?|min|hours?|hrs?|h|days?|d)\b\s*(.*)$/is))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit.startsWith('d') ? 864e5 : unit.startsWith('h') ? 36e5 : 6e4;
    const text = stripLead(m[3]);
    if (!text || !n) return null;
    return { dueMs: nowMs + n * mult, text };
  }

  // tomorrow [at HH[:MM]]
  if ((m = s.match(/^tomorrow(?:\s+at\s+(\d{1,2})(?:[:.](\d{2}))?)?\s*(.*)$/is))) {
    const hh = m[1] !== undefined ? Number(m[1]) : 9;
    const mm = m[2] ? Number(m[2]) : 0;
    const text = stripLead(m[3]);
    if (!text || hh > 23 || mm > 59) return null;
    return { dueMs: berlinToUtcMs(now.y, now.m, now.d + 1, hh, mm), text };
  }

  // [today] at HH[:MM]  (tomorrow if that time already passed)
  if ((m = s.match(/^(?:today\s+)?at\s+(\d{1,2})(?:[:.](\d{2}))?\s*(.*)$/is))) {
    const hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const text = stripLead(m[3]);
    if (!text || hh > 23 || mm > 59) return null;
    let due = berlinToUtcMs(now.y, now.m, now.d, hh, mm);
    if (due <= nowMs) due = berlinToUtcMs(now.y, now.m, now.d + 1, hh, mm);
    return { dueMs: due, text };
  }

  // on <weekday> [at HH[:MM]]  (next occurrence)
  if ((m = s.match(/^on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(\d{1,2})(?:[:.](\d{2}))?)?\s*(.*)$/is))) {
    const target = WEEKDAYS[m[1].toLowerCase()];
    const hh = m[2] !== undefined ? Number(m[2]) : 9;
    const mm = m[3] ? Number(m[3]) : 0;
    const text = stripLead(m[4]);
    if (!text || hh > 23 || mm > 59) return null;
    const todayDow = new Date(Date.UTC(now.y, now.m - 1, now.d)).getUTCDay();
    const ahead = (target - todayDow + 7) % 7;
    let due = berlinToUtcMs(now.y, now.m, now.d + ahead, hh, mm);
    if (due <= nowMs) due = berlinToUtcMs(now.y, now.m, now.d + ahead + 7, hh, mm);
    return { dueMs: due, text };
  }

  // on DD.MM.[YYYY] [at HH[:MM]]
  if ((m = s.match(/^on\s+(\d{1,2})\.(\d{1,2})\.?(\d{4})?(?:\s+at\s+(\d{1,2})(?:[:.](\d{2}))?)?\s*(.*)$/is))) {
    const d = Number(m[1]), mo = Number(m[2]);
    const y = m[3] ? Number(m[3]) : now.y;
    const hh = m[4] !== undefined ? Number(m[4]) : 9;
    const mm = m[5] ? Number(m[5]) : 0;
    const text = stripLead(m[6]);
    if (!text || d > 31 || mo > 12 || hh > 23 || mm > 59) return null;
    let due = berlinToUtcMs(y, mo, d, hh, mm);
    if (!m[3] && due <= nowMs) due = berlinToUtcMs(y + 1, mo, d, hh, mm); // no year given & past -> next year
    return { dueMs: due, text };
  }

  // on YYYY-MM-DD [at HH[:MM]]
  if ((m = s.match(/^on\s+(\d{4})-(\d{2})-(\d{2})(?:\s+at\s+(\d{1,2})(?:[:.](\d{2}))?)?\s*(.*)$/is))) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const hh = m[4] !== undefined ? Number(m[4]) : 9;
    const mm = m[5] ? Number(m[5]) : 0;
    const text = stripLead(m[6]);
    if (!text || hh > 23 || mm > 59) return null;
    return { dueMs: berlinToUtcMs(y, mo, d, hh, mm), text };
  }

  return null;
}

// ---------- storage ----------

async function ensureTab() {
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${TAB}!A1:D1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Email', 'Due (UTC)', 'Reminder', 'Status']] }
    });
    console.log('⏰ Created REMINDERS tab.');
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
}

// Returns 'saved' | 'past' | 'too_far' | 'too_long'
async function addReminder(email, dueMs, text) {
  if (dueMs <= Date.now()) return 'past';
  if (dueMs > Date.now() + MAX_AHEAD_MS) return 'too_far';
  if ((text || '').length > MAX_TEXT) return 'too_long';
  await ensureTab();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${TAB}!A:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[(email || '').toLowerCase(), new Date(dueMs).toISOString(), text, '']] }
  });
  console.log(`⏰ Reminder stored for ${email}: ${new Date(dueMs).toISOString()} "${text.slice(0, 60)}"`);
  return 'saved';
}

async function readAllRows() {
  const sheets = getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${TAB}!A2:D`
    });
    return res.data.values || [];
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) return null; // tab doesn't exist yet
    throw err;
  }
}

// Open (unsent, uncancelled) reminders of ONE user, with their sheet row numbers.
async function listOpenReminders(email) {
  const rows = (await readAllRows()) || [];
  const mine = [];
  const key = (email || '').toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const [rowEmail, dueIso, text, status] = rows[i];
    if ((rowEmail || '').toLowerCase() !== key || status || !dueIso) continue;
    mine.push({ row: i + 2, dueMs: Date.parse(dueIso), text: text || '' });
  }
  mine.sort((a, b) => a.dueMs - b.dueMs);
  return mine;
}

// Cancel the n-th (1-based, as shown by "my reminders") open reminder.
// Returns the cancelled reminder or null.
async function cancelReminder(email, n) {
  const mine = await listOpenReminders(email);
  const pick = mine[n - 1];
  if (!pick) return null;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${TAB}!D${pick.row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[`cancelled ${new Date().toISOString()}`]] }
  });
  console.log(`⏰ Reminder cancelled for ${email}: row ${pick.row}`);
  return pick;
}

// ---------- delivery (cron, every minute) ----------
let checking = false;

async function checkDueReminders() {
  if (checking) return null; // previous run still going — skip this tick
  checking = true;
  try {
    const rows = await readAllRows();
    if (!rows) return null;
    const sheets = getSheetsClient();
    const now = Date.now();
    let sent = 0, failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const [email, dueIso, text, status] = rows[i];
      if (!email || status || !dueIso) continue;
      const due = Date.parse(dueIso);
      if (Number.isNaN(due) || due > now) continue;
      let ok = false;
      try {
        ok = await sendDm(email, `⏰ *Reminder:* ${text} 🐾`);
      } catch (err) {
        console.warn(`⚠️ reminder DM failed for ${email}: ${err.message}`);
      }
      // mark the row either way — a broken DM channel must not retry forever
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${TAB}!D${i + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[ok ? new Date().toISOString() : `failed ${new Date().toISOString()}`]] }
      });
      ok ? sent++ : failed++;
      await new Promise(r => setTimeout(r, 250));
    }
    if (sent || failed) console.log(`⏰ One-off reminders: ${sent} sent · ${failed} failed.`);
    return { sent, failed };
  } finally {
    checking = false;
  }
}

module.exports = {
  parseReminder, addReminder, listOpenReminders, cancelReminder,
  checkDueReminders, fmtBerlin, berlinParts, berlinToUtcMs
};
