// Kitten-Tasks.js — Google Tasks integration (per user, in THEIR account).
//
// The Kitten can:
//  - CREATE a task in the user's own Google Tasks (default list), optionally
//    with a due date — triggered via chat ("create me a task ...") + dialog.
//  - READ the user's tasks to send the daily "due today" digest DM
//    (only for users who enabled it in their Kitten Brain settings).
//
// The Kitten NEVER deletes or completes tasks — there is no code for it.
//
// Access: domain-wide delegation impersonating THE USER with scope
//   https://www.googleapis.com/auth/tasks
// Setup: enable the "Google Tasks API" in the GCP project and add the scope
// to the existing DWD client ID (see documentation §8).

const { google } = require('googleapis');
const { listBrainEmails, getSettings } = require('./Kitten-Brain');
const { sendDm } = require('./Chat-Poster');

const userClients = new Map(); // email -> tasks client

function getUserTasksClient(email) {
  if (userClients.has(email)) return userClients.get(email);
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/tasks'],
    subject: email
  });
  const c = google.tasks({ version: 'v1', auth });
  userClients.set(email, c);
  return c;
}

// Create a task in the user's DEFAULT task list.
// dueMs: optional epoch milliseconds (date only — Google Tasks ignores time).
async function createTask(email, title, dueMs) {
  const tasks = getUserTasksClient(email);
  const requestBody = { title };
  if (dueMs) {
    const d = new Date(Number(dueMs));
    requestBody.due = d.toISOString().slice(0, 10) + 'T00:00:00.000Z';
  }
  const res = await tasks.tasks.insert({ tasklist: '@default', requestBody });
  console.log(`📝 Task created for ${email}: "${title}"${requestBody.due ? ` (due ${requestBody.due.slice(0, 10)})` : ''}`);
  return res.data;
}

// All open tasks of the user that are due TODAY or OVERDUE (across all lists).
async function getTasksDueToday(email) {
  const tasks = getUserTasksClient(email);
  const lists = (await tasks.tasklists.list({ maxResults: 25 })).data.items || [];

  // "today" in Berlin time
  const now = new Date();
  const berlin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const endOfToday = new Date(Date.UTC(berlin.getFullYear(), berlin.getMonth(), berlin.getDate(), 23, 59, 59));
  const startOfToday = new Date(Date.UTC(berlin.getFullYear(), berlin.getMonth(), berlin.getDate(), 0, 0, 0));

  const dueToday = [];
  const overdue = [];
  for (const list of lists) {
    const res = await tasks.tasks.list({
      tasklist: list.id,
      showCompleted: false,
      dueMax: endOfToday.toISOString(),
      maxResults: 100
    });
    for (const t of res.data.items || []) {
      if (!t.title || !t.due) continue;
      const due = new Date(t.due);
      if (due < startOfToday) overdue.push({ title: t.title, list: list.title });
      else dueToday.push({ title: t.title, list: list.title });
    }
  }
  return { dueToday, overdue };
}

// Daily digest: DM every opted-in brain owner their tasks for today.
// Runs HOURLY — `hour` (Berlin) selects the users whose configured
// digest_hour matches; onlyEmail = manual single-user test (ignores opt-in).
// Returns a summary string (also used by the manual /jobs trigger).
async function runDailyTaskDigest(onlyEmail, hour = null) {
  const emails = onlyEmail ? [onlyEmail] : await listBrainEmails();
  let sent = 0, skipped = 0, empty = 0, failed = 0;

  for (const email of emails) {
    try {
      const s = await getSettings(email);
      if (!onlyEmail && (!s.reminders_enabled || !s.daily_tasks)) { skipped++; continue; }
      if (!onlyEmail && hour !== null && Number(s.digest_hour) !== Number(hour)) { skipped++; continue; }

      const { dueToday, overdue } = await getTasksDueToday(email);
      if (!dueToday.length && !overdue.length) { empty++; continue; }

      let text = `⏰ *Good morning! Here are your tasks for today:*\n`;
      for (const t of dueToday) text += `\n☐ ${t.title}${t.list && t.list !== 'My Tasks' ? `  _(${t.list})_` : ''}`;
      if (overdue.length) {
        text += `\n\n⚠️ *Still open from earlier days:*`;
        for (const t of overdue) text += `\n☐ ${t.title}${t.list && t.list !== 'My Tasks' ? `  _(${t.list})_` : ''}`;
      }
      text += `\n\n_You can turn this off any time: type *kitten* → ⏰ Reminder settings._ 🐾`;

      (await sendDm(email, text)) ? sent++ : failed++;
    } catch (err) {
      console.warn(`⚠️ task digest failed for ${email}: ${err.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  const summary = `⏰ Task digest${hour !== null ? ` (${String(hour).padStart(2, '0')}:00 Berlin)` : ''}: ${sent} sent · ${skipped} skipped (opt-in/time) · ${empty} nothing due · ${failed} failed (${emails.length} brains checked).`;
  console.log(summary);
  return summary;
}

// Current hour in Berlin (0-23) — used by the hourly cron.
function berlinHour() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(new Date()));
}

module.exports = { createTask, getTasksDueToday, runDailyTaskDigest, berlinHour };
