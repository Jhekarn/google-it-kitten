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
const { getTodaysEvents } = require('./Kitten-Brief');

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

  // Google Tasks due dates have NO time — the API stores the calendar date
  // (normally as midnight UTC), so we compare CALENDAR DATES, not timestamps.
  // "today" = today's date in Berlin. dueMax is set to TOMORROW so today's
  // tasks are always safely inside the API filter, whatever its edge
  // (inclusive/exclusive) behavior is — the exact day sorting happens here.
  const berlinToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()); // YYYY-MM-DD
  const [y, m, d] = berlinToday.split('-').map(Number);
  const startOfTomorrow = new Date(Date.UTC(y, m - 1, d + 1));

  const dueToday = [];
  const overdue = [];
  for (const list of lists) {
    const res = await tasks.tasks.list({
      tasklist: list.id,
      showCompleted: false,
      dueMax: startOfTomorrow.toISOString(),
      maxResults: 100
    });
    for (const t of res.data.items || []) {
      if (!t.title || !t.due) continue;
      const dueDate = String(t.due).slice(0, 10); // the task's calendar date
      if (dueDate > berlinToday) continue;        // tomorrow or later — not yet
      if (dueDate < berlinToday) overdue.push({ title: t.title, list: list.title });
      else dueToday.push({ title: t.title, list: list.title });
    }
  }
  return { dueToday, overdue };
}

// Daily digest DM: tasks due today (daily_tasks) and/or the morning
// day-brief with today's meetings (morning_brief) — combined in ONE message,
// sent at each user's configured digest_hour (Berlin).
// The cron ticks hourly — `hour` selects the users whose configured
// digest_hour matches; onlyEmail = manual single-user test (ignores opt-in).
// Returns a summary string (also used by the manual /jobs trigger).
async function runDailyTaskDigest(onlyEmail, hour = null) {
  const emails = onlyEmail ? [onlyEmail] : await listBrainEmails();
  let sent = 0, skipped = 0, empty = 0, failed = 0;

  for (const email of emails) {
    try {
      const s = await getSettings(email);
      if (!onlyEmail && (!s.reminders_enabled || (!s.daily_tasks && !s.morning_brief))) { skipped++; continue; }
      if (!onlyEmail && hour !== null && Number(s.digest_hour) !== Number(hour)) { skipped++; continue; }
      const wantTasks = onlyEmail ? true : !!s.daily_tasks;
      const wantBrief = onlyEmail ? true : !!s.morning_brief;

      // calendar (morning brief) — graceful: a failed read just drops the section
      let events = null;
      if (wantBrief) {
        try {
          events = await getTodaysEvents(email);
        } catch (err) {
          console.warn(`⚠️ calendar read failed for ${email}: ${err.message}`);
        }
      }

      // tasks
      let dueToday = [], overdue = [];
      if (wantTasks) ({ dueToday, overdue } = await getTasksDueToday(email));

      const hasTasks = dueToday.length || overdue.length;
      // stay quiet when there is nothing to say: tasks-only users with no due
      // tasks, and brief users whose calendar read failed with no tasks either
      if (!hasTasks && (!wantBrief || events === null)) { empty++; continue; }

      let text = wantBrief && events !== null
        ? `🌅 *Good morning! Here's your day:*\n`
        : `⏰ *Good morning! Here are your tasks for today:*\n`;

      if (wantBrief && events !== null) {
        text += `\n📅 *Meetings today:*`;
        if (!events.length) text += `\n— none. Enjoy the focus time! 🎉`;
        else for (const e of events) text += `\n${e.allDay ? '🗓️ All day' : '🕐 ' + e.time} — ${e.summary}`;
      }

      if (hasTasks) {
        if (wantBrief && events !== null) text += `\n\n📝 *Tasks:*`;
        for (const t of dueToday) text += `\n🔹 ${t.title}${t.list && t.list !== 'My Tasks' ? `  _(${t.list})_` : ''}`;
        if (overdue.length) {
          text += `\n\n⚠️ *Still open from earlier days:*`;
          for (const t of overdue) text += `\n🔸 ${t.title}${t.list && t.list !== 'My Tasks' ? `  _(${t.list})_` : ''}`;
        }
      } else if (wantTasks && wantBrief && events !== null) {
        text += `\n\n📝 *Tasks:* nothing due today ✅`;
      }

      text += `\n\n_You can change this any time: type *kitten* → ⏰ Reminder settings._ 🐾`;

      (await sendDm(email, text)) ? sent++ : failed++;
    } catch (err) {
      console.warn(`⚠️ daily digest failed for ${email}: ${err.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  const summary = `⏰ Daily digest${hour !== null ? ` (${String(hour).padStart(2, '0')}:00 Berlin)` : ''}: ${sent} sent · ${skipped} skipped (opt-in/time) · ${empty} nothing due · ${failed} failed (${emails.length} brains checked).`;
  console.log(summary);
  return summary;
}

// Current hour in Berlin (0-23) — used by the hourly cron.
function berlinHour() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(new Date()));
}

module.exports = { createTask, getTasksDueToday, runDailyTaskDigest, berlinHour };
