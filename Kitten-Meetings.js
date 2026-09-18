// Kitten-Meetings.js — Google Calendar meetings (per user, in THEIR account).
//
// The Kitten can:
//  - CREATE a calendar event in the user's primary calendar ("📅 Plan a
//    meeting" dialog) — with guests, an automatic Google Meet link, and
//    standard Google invitations sent to all guests.
//  - FIND A TIME: check the FREE/BUSY status of all requested guests
//    (busy blocks only — never event details!) and suggest up to 3 slots
//    on the chosen day where everyone is free. Calendars the Kitten cannot
//    read (external guests, fully restricted calendars) are reported as
//    unreadable and simply excluded from the calculation.
//
// The Kitten only ever CREATES events — it never edits or deletes any.
//
// Access: domain-wide delegation impersonating THE USER with two scopes:
//   https://www.googleapis.com/auth/calendar.events   -> creating events
//   https://www.googleapis.com/auth/calendar.readonly -> free/busy lookups
//   (Google's freebusy endpoint is NOT covered by calendar.events, so
//   find-a-time uses a separate readonly client. calendar.readonly is the
//   same scope the morning day-brief already uses. Org-internal calendars
//   share free/busy by Workspace default.)
// Setup: Google Calendar API enabled + both scopes on the DWD client ID.

const { google } = require('googleapis');
const { berlinParts, berlinToUtcMs } = require('./Kitten-Reminders');

const userClients = new Map(); // email -> calendar client (events scope)
const fbClients = new Map();   // email -> calendar client (readonly scope, free/busy)

function getUserEventsClient(email) {
  if (userClients.has(email)) return userClients.get(email);
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    subject: email
  });
  const c = google.calendar({ version: 'v3', auth });
  userClients.set(email, c);
  return c;
}

// free/busy requires calendar.readonly (calendar.events does not cover it)
function getUserFreeBusyClient(email) {
  if (fbClients.has(email)) return fbClients.get(email);
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    subject: email
  });
  const c = google.calendar({ version: 'v3', auth });
  fbClients.set(email, c);
  return c;
}

// Parse a comma/semicolon/space separated guest list into clean emails.
function parseGuests(raw) {
  return [...new Set(String(raw || '')
    .split(/[\s,;]+/)
    .map(g => g.trim().toLowerCase())
    .filter(g => g.includes('@')))].slice(0, 20);
}

// Create an event in the USER's primary calendar. Guests get the normal
// Google invitation; a Google Meet link is attached automatically.
// Returns { htmlLink, meetLink, startMs, endMs }.
async function createEvent(email, { title, startMs, durationMin, guests = [], description = '' }) {
  const cal = getUserEventsClient(email);
  const endMs = startMs + durationMin * 60000;
  const res = await cal.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: title,
      description: description || undefined,
      start: { dateTime: new Date(startMs).toISOString(), timeZone: 'Europe/Berlin' },
      end: { dateTime: new Date(endMs).toISOString(), timeZone: 'Europe/Berlin' },
      attendees: guests.map(g => ({ email: g })),
      conferenceData: {
        createRequest: {
          requestId: `kitten-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }
  });
  const ev = res.data || {};
  const meetLink = ev.hangoutLink ||
    ev.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null;
  console.log(`📅 Event created for ${email}: "${title}" (${guests.length} guest(s))`);
  return { htmlLink: ev.htmlLink || null, meetLink, startMs, endMs };
}

// Find up to `maxSlots` free slots on ONE day (Berlin) where the organizer
// AND all readable guests are free. windowStartH/windowEndH come from the
// user's Meeting Settings (default 9–18).
// Returns { slots: [startMs], readable: [emails], unreadable: [emails] }.
async function findFreeSlots(email, { y, m, d, durationMin, guests = [], windowStartH = 9, windowEndH = 18, maxSlots = 3 }) {
  const cal = getUserFreeBusyClient(email);
  const people = [...new Set([email.toLowerCase(), ...guests])];
  const winStart = berlinToUtcMs(y, m, d, windowStartH, 0);
  const winEnd = berlinToUtcMs(y, m, d, windowEndH, 0);

  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: new Date(winStart).toISOString(),
      timeMax: new Date(winEnd).toISOString(),
      timeZone: 'Europe/Berlin',
      items: people.map(p => ({ id: p }))
    }
  });

  const calendars = res.data.calendars || {};
  const readable = [];
  const unreadable = [];
  let busy = [];
  for (const p of people) {
    const entry = calendars[p];
    if (!entry || (entry.errors && entry.errors.length)) {
      if (p !== email.toLowerCase()) unreadable.push(p);
      continue;
    }
    readable.push(p);
    for (const b of entry.busy || []) {
      busy.push([Date.parse(b.start), Date.parse(b.end)]);
    }
  }

  // merge overlapping busy blocks
  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of busy) {
    if (merged.length && b[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b[1]);
    } else {
      merged.push([...b]);
    }
  }

  // scan the window in 15-min steps; suggestions at least `durationMin` apart
  const durMs = durationMin * 60000;
  const step = 15 * 60000;
  const now = Date.now();
  const slots = [];
  let nextAllowed = winStart;
  for (let t = winStart; t + durMs <= winEnd; t += step) {
    if (t < nextAllowed) continue;
    if (t + durMs <= now) continue;          // never suggest the past
    if (t <= now && now < t + durMs) continue;
    const clash = merged.some(([bs, be]) => t < be && bs < t + durMs);
    if (!clash) {
      slots.push(t);
      nextAllowed = t + durMs; // spread suggestions
      if (slots.length >= maxSlots) break;
    }
  }

  return { slots, readable, unreadable };
}

module.exports = { createEvent, findFreeSlots, parseGuests };
