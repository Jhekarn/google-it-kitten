// Kitten-Brief.js — morning day-brief: today's Google Calendar events.
//
// Read-only: the Kitten NEVER creates, changes or deletes calendar events.
//
// Access: domain-wide delegation impersonating THE USER with scope
//   https://www.googleapis.com/auth/calendar.readonly
// Setup: enable the "Google Calendar API" in the GCP project and add the
// scope to the existing DWD client ID (same procedure as the Tasks scope).

const { google } = require('googleapis');
const { berlinParts, berlinToUtcMs } = require('./Kitten-Reminders');

const userClients = new Map(); // email -> calendar client

function getUserCalendarClient(email) {
  if (userClients.has(email)) return userClients.get(email);
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    subject: email
  });
  const c = google.calendar({ version: 'v3', auth });
  userClients.set(email, c);
  return c;
}

// Today's events (Berlin day) from the user's primary calendar, ordered by
// start time. Returns [{ allDay, time?, summary }].
async function getTodaysEvents(email) {
  const cal = getUserCalendarClient(email);
  const now = berlinParts();
  const timeMin = new Date(berlinToUtcMs(now.y, now.m, now.d, 0, 0)).toISOString();
  const timeMax = new Date(berlinToUtcMs(now.y, now.m, now.d + 1, 0, 0)).toISOString();

  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20
  });

  const events = [];
  for (const e of res.data.items || []) {
    if (e.status === 'cancelled' || !e.summary) continue;
    if (e.start?.date) { // all-day event
      events.push({ allDay: true, summary: e.summary });
      continue;
    }
    if (!e.start?.dateTime) continue;
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(e.start.dateTime));
    events.push({ allDay: false, time, summary: e.summary });
  }
  return events;
}

module.exports = { getTodaysEvents };
