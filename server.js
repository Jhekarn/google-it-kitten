// server.js — google-it-kitten foundation
//
// Google Chat version of the IT Kitten Bot. Google PUSHES events to this
// public HTTPS endpoint:
//
//   Google Chat  --POST-->  https://google-it-kitten.onrender.com/chat
//
// This app is registered in Google's NEW add-on event format: the payload has
// no top-level "type" — instead the event lives under event.chat.*Payload and
// shared data under event.commonEventObject. Responses are wrapped in
// hostAppDataAction / action objects (see Menu-Card.js).
//
// The classic format (top-level type: MESSAGE etc.) is still supported so the
// local test script keeps working.

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const { chatAuthMiddleware } = require('./Chat-Auth');
const {
  buttonAction,
  buildHelpMessage,
  buildAnswerMessage,
  buildFaqResultsMessage,
  buildSelectionMessage,
  buildFaqDialogCardObject,
  buildJiraDialogCardObject,
  buildTicketCreatedMessage,
  buildSettingsCardObject,
  buildAutomationsCardObject,
  buildN8nConnectedMessage,
  buildN8nCodeMessage,
  buildSecretRevealCardObject,
  buildFunctionsCardObject,
  buildMyRemindersCardObject,
  buildAdminCardObject,
  buildTaskDialogCardObject,
  buildTaskOfferMessage,
  buildTicketOfferAnswerMessage,
  buildMeetingPlannerCardObject,
  buildMeetingHubMessage,
  buildFindTimeResultsMessage,
  answerTextFor,
  extractUrls,
  isLinkOnlyAnswer,
  wrappers
} = require('./Menu-Card');
const { appendFAQToSheet } = require('./GoogleSheet-Handler');
const { searchFAQs, findFAQ } = require('./FAQ-DB');
const { createJiraTicket } = require('./Jira');
const { getUserOpenTickets, buildMyTicketsPage } = require('./Jira-MyTickets');
const { runWeeklyReport } = require('./IH-Project-Satisfaction-WeeklyReport');
const { run: runDailyReminder } = require('./IH-Customer-Waiting-Reminder');
const { postOps, postToSpace: postToSpaceViaPoster, postMessageToSpace, listKittenSpaces, listUserSpaces, isSpaceMember, sendDm, getUserInfo, listDomainUsers } = require('./Chat-Poster');
const n8n = require('./N8N-Connector');
const { askKitten, isEnabled: geminiEnabled } = require('./Gemini-Handler');
const { createBrain, rememberFact, getMemories, getBrain, getSettings, setSettings, isAdmin } = require('./Kitten-Brain');
const { createTask, runDailyTaskDigest, berlinHour } = require('./Kitten-Tasks');
const { parseReminder, addReminder, listOpenReminders, cancelReminder, cancelReminderByRow, checkDueReminders, fmtBerlin, berlinParts, berlinToUtcMs } = require('./Kitten-Reminders');
const { createEvent, findFreeSlots, findFreeSlotsWeek, parseGuests } = require('./Kitten-Meetings');

// "10:15" in Berlin time — for meeting slot labels
const berlinHHMM = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
// "Thu 24/09/2026" in Berlin time
const berlinDay = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms)).replace(',', '');
// "Thu 24/09" in Berlin time — short, for week-scan slot buttons
const berlinDayShort = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(ms)).replace(',', '');

// ---- Short-term conversation memory + ticket drafts (v2.9.0) ----
// RAM ONLY, by design: nothing is ever written to a sheet. Both stores
// auto-expire and are hard-capped, so worst-case memory use is a few MB.
// A restart/deploy simply clears them (the Kitten forgets the last hour of
// small talk — harmless, and the ticket-offer click handles a missing draft).
const CHAT_TTL_MS = 60 * 60 * 1000;   // forget conversations after 1h idle
const CHAT_MAX_TURNS = 8;             // turns kept per user (user+model)
const CHAT_TURN_MAX_CHARS = 500;      // long pastes are truncated before storing
const CHAT_MAX_USERS = 300;           // LRU cap across all users

const chatHistories = new Map();      // email -> { turns: [{role, text}], at }
const ticketDrafts = new Map();       // email -> { draft: {title, description, steps_tried, team}, at }

function getHistory(email) {
  if (!email) return [];
  const h = chatHistories.get(email);
  if (!h) return [];
  if (Date.now() - h.at > CHAT_TTL_MS) { chatHistories.delete(email); return []; }
  return h.turns;
}

function pushHistory(email, role, text) {
  if (!email || !text) return;
  const h = chatHistories.get(email) || { turns: [], at: 0 };
  h.turns.push({ role, text: String(text).slice(0, CHAT_TURN_MAX_CHARS) });
  if (h.turns.length > CHAT_MAX_TURNS) h.turns.splice(0, h.turns.length - CHAT_MAX_TURNS);
  h.at = Date.now();
  chatHistories.set(email, h);
  if (chatHistories.size > CHAT_MAX_USERS) {           // evict least recently active
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of chatHistories) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) chatHistories.delete(oldestKey);
  }
}

function storeTicketDraft(email, draft) {
  if (!email || !draft) return;
  ticketDrafts.set(email, { draft, at: Date.now() });
  if (ticketDrafts.size > CHAT_MAX_USERS) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of ticketDrafts) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) ticketDrafts.delete(oldestKey);
  }
}

function takeTicketDraft(email) {
  const d = email && ticketDrafts.get(email);
  if (!d) return null;
  if (Date.now() - d.at > CHAT_TTL_MS) { ticketDrafts.delete(email); return null; }
  return d.draft;
}

// ---- Pending N8N secret reveals (v2.10.3) — RAM ONLY, deleted on read ----
// After a successful connection the plaintext secret is parked here until the
// owner clicks "🔐 Reveal secret". The click TAKES it (delete-on-read), so
// the popup works exactly once; afterwards the plaintext exists nowhere but
// the owner's N8N node (the sheet stores only a SHA-256 fingerprint).
// TTL 1h; a restart clears it — then the owner revokes + reconnects.
const pendingSecrets = new Map(); // email -> { name, secret, at }

function storePendingSecret(email, name, secret) {
  if (!email || !secret) return;
  pendingSecrets.set(email, { name, secret, at: Date.now() });
  if (pendingSecrets.size > CHAT_MAX_USERS) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of pendingSecrets) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) pendingSecrets.delete(oldestKey);
  }
}

function takePendingSecret(email) {
  const d = email && pendingSecrets.get(email);
  if (!d) return null;
  pendingSecrets.delete(email); // delete-on-read: the reveal works ONCE
  if (Date.now() - d.at > CHAT_TTL_MS) return null;
  return d;
}

// ---- Prepared announcement DMs (used by /jobs AND the 🛠️ Admin dialog) ----
const ANNOUNCEMENTS = {
  'dm-all': {
    label: '🤫 "Psst" chat intro (dm-all)',
    text: (firstName) =>
      `Hey psst ${firstName || 'there'} 🐱 ...don't tell anyone, but you can also *chat with me* ` +
      `to assist you — just send me any IT question right here. Maybe give it a try? 😉`
  },
  'announce-brain': {
    label: '🧠 Kitten Brain announcement',
    text: (firstName) =>
      `Hey ${firstName || 'there'} 🧠 I learned a new trick — I can now *remember things, just for you*!\n\n` +
      `Type *kitten* and click *🧠 Create Kitten Brain*. From then on, start any message with ` +
      `*remember* (e.g. "remember I use a MacBook Pro") and I’ll keep it in mind whenever we chat. ` +
      `To make me forget something, just open your memory sheet and delete the row.\n\n` +
      `🔒 Your memories live in YOUR own Google Drive — nobody else can see them, ` +
      `and they’re only ever used in your own conversations with me. 🐾`
  },
  'announce-tasks': {
    label: '⏰ Reminders & Tasks announcement',
    text: (firstName) =>
      `Hey ${firstName || 'there'} 🐱 Oh, by the way... I completely *forgot* to mention — I have another new feature. ` +
      `What a surprise: it's exactly for *not forgetting* things! 😹\n\n` +
      `⏰ *Daily task reminder* — every morning I can send you a DM with your Google Tasks that are due today ` +
      `(plus anything still open from earlier days). You pick the time — default is 08:00 Berlin time.\n` +
      `📝 *Create tasks by chat* — just write me something like "create me a task for ordering a new cable" ` +
      `and I'll put it straight into your Google Tasks, with an optional target date. ` +
      `(Don't worry — I only create tasks, I never delete or complete them.)\n\n` +
      `*How to switch it on:* type *kitten* → *⚙️ Settings* → enable ` +
      `"Remind me of my tasks due today" and pick your time. ` +
      `(If you don't have a 🧠 Kitten Brain yet, create that first — the settings live in there.) 🐾`
  }
};

// DM every (active) user in the domain, throttled; summary goes to ops.
// Used by the /jobs endpoints and the 🛠️ Admin dialog.
async function dmEveryone(label, messageFor) {
  const users = await listDomainUsers();
  let sent = 0, noDm = 0, failed = 0;
  for (const u of users) {
    try {
      (await sendDm(u.email, messageFor(u.firstName))) ? sent++ : noDm++;
    } catch (err) {
      console.warn(`⚠️ ${label}: ${u.email} failed: ${err.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 250)); // stay well under Chat API quotas
  }
  const summary = `${label} *finished:* ${sent} sent · ${noDm} without DM channel · ${failed} failed (of ${users.length} users).`;
  console.log(summary);
  await postOps(summary);
  return summary;
}

// ---- Scheduled jobs (like the Slack server.js) ----
// Every Monday 08:00 UTC (= 09:00/10:00 Berlin): weekly satisfaction report
cron.schedule('0 8 * * 1', async () => {
  console.log('⏰ Running weekly satisfaction report...');
  try {
    await runWeeklyReport();
  } catch (err) {
    console.error('🚨 Weekly report failed:', err.message);
    await postOps(`🚨 *Weekly satisfaction report failed:* ${err.message}`);
  }
});

// Daily 05:00 UTC: IH "waiting for customer" reminder
cron.schedule('0 5 * * *', async () => {
  console.log('⏰ Running daily IH reminder...');
  try {
    await runDailyReminder();
    console.log('✅ Daily IH reminder completed.');
  } catch (err) {
    console.error('🚨 Daily IH reminder failed:', err.message);
    await postOps(`🚨 *Daily IH reminder failed:* ${err.message}`);
  }
});

// HOURLY (Berlin time, DST-safe): daily digest DM (tasks due today and/or the
// morning day-brief) — each user at THEIR configured hour (default 08:00).
cron.schedule('0 * * * *', async () => {
  const hour = berlinHour();
  try {
    const summary = await runDailyTaskDigest(null, hour);
    // only report to ops when something actually happened this hour
    if (!/ 0 sent /.test(summary)) await postOps(summary);
  } catch (err) {
    console.error('🚨 Daily digest failed:', err.message);
    await postOps(`🚨 *Daily digest (${hour}:00 Berlin) failed:* ${err.message}`);
  }
}, { timezone: 'Europe/Berlin' });

// EVERY MINUTE: deliver due one-off reminders ("remind me in 2 hours ...").
// A single central sheet read per tick; quiet unless something was sent.
let reminderFailStreak = 0;
cron.schedule('* * * * *', async () => {
  try {
    await checkDueReminders();
    reminderFailStreak = 0;
  } catch (err) {
    console.error('🚨 Reminder check failed:', err.message);
    // don't spam ops every minute — report once when it starts failing
    if (++reminderFailStreak === 3) {
      await postOps(`🚨 *One-off reminder delivery is failing:* ${err.message}`).catch(() => null);
    }
  }
});

const app = express();
app.use(express.json());
// N8N workflows may also send raw text bodies to /n8n/<code> (JSON stays the default)
app.use(express.text({ type: 'text/*', limit: '16kb' }));

// Request log (set ENABLE_DEBUG_EVENTS=1 in env to also dump full payloads)
app.use((req, _res, next) => {
  console.log(`📥 ${req.method} ${req.url} | auth header: ${req.headers.authorization ? 'yes' : 'no'}`);
  if (req.method === 'POST' && process.env.ENABLE_DEBUG_EVENTS === '1') {
    console.log('📦 BODY:', JSON.stringify(req.body));
  }
  next();
});

// ---- Health check ----
app.get('/', (_req, res) => {
  res.send('🐱 IT Kitten for Google Chat is running.');
});

// ---- Manual job triggers for testing (guarded by ADMIN_JOB_KEY env) ----
// Usage: open https://<render-url>/jobs/weekly?key=YOUR_KEY in the browser.
app.get('/jobs/:job', async (req, res) => {
  if (!process.env.ADMIN_JOB_KEY || req.query.key !== process.env.ADMIN_JOB_KEY) {
    return res.status(403).send('Forbidden');
  }
  try {
    if (req.params.job === 'weekly') {
      await runWeeklyReport();
      return res.send('✅ Weekly report executed.');
    }
    if (req.params.job === 'reminder') {
      await runDailyReminder();
      return res.send('✅ Daily reminder executed.');
    }
    // Broadcast: introduce the Kitten (port of broadcast.js). Posts to
    // REPORT_SPACE_ID by default; override with &space=spaces/XXXX.
    if (req.params.job === 'broadcast') {
      const target = req.query.space || process.env.REPORT_SPACE_ID;
      if (!target) return res.status(400).send('No target space (set REPORT_SPACE_ID or pass &space=).');
      const text =
        `*Good Morning people of USC.* 🐱 As most of you might not be aware I exist, ` +
        `here is a quick intro of what I can help you with in Google Chat:\n\n` +
        `🎫 *Create a Jira ticket* – click the *Create a Jira Ticket* button to report an issue.\n` +
        `📚 *FAQ & HowTo guides* – search the IT knowledge base by keyword, directly in Chat.\n` +
        `🔑 *Request account access* – use the *Request accounts* button to learn how to start.\n` +
        `📶 *WiFi passwords* – I can remind you of those too.\n` +
        `📋 *My open tickets* – see all your open Jira tickets in one place.\n\n` +
        `*How to reach me:* send me a direct message with the word "kitten", ` +
        `or use /kitten in any space I have joined for the menu.`;
      await postToSpaceViaPoster(target, text);
      return res.send(`✅ Broadcast posted to ${target}.`);
    }
    // 🤫 DM-all: personalized "psst" DM to every user in the domain.
    // Single-user test:   /jobs/dm-all?key=…&email=someone@urbansportsclub.com
    // Full run (everyone): /jobs/dm-all?key=…&confirm=1
    // The full run responds immediately and works in the background; the
    // summary (sent / no DM channel / failed) is posted to the ops space.
    // dm-all / announce-brain / announce-tasks — all use the shared
    // ANNOUNCEMENTS templates + dmEveryone (also reachable via 🛠️ Admin).
    if (ANNOUNCEMENTS[req.params.job]) {
      const { label, text: messageFor } = ANNOUNCEMENTS[req.params.job];

      // Test mode: one user only
      if (req.query.email) {
        const info = await getUserInfo(req.query.email);
        const ok = await sendDm(req.query.email, messageFor(info?.firstName));
        return res.send(ok
          ? `✅ Test DM sent to ${req.query.email}${info?.firstName ? ` (as "${info.firstName}")` : ''}.`
          : `❌ Could not DM ${req.query.email} — no DM channel with the Kitten yet?`);
      }

      // Safety: the full run must be confirmed explicitly
      if (req.query.confirm !== '1') {
        return res.status(400).send(
          'This would DM EVERY user in the domain. Add &confirm=1 to really run it, or &email=someone@… for a single test.');
      }

      res.send(`🚀 Started: sending "${label}" to everyone in the background. Summary goes to the ops space.`);
      dmEveryone(label, messageFor)
        .catch(err => postOps(`🚨 *${req.params.job} crashed:* ${err.message}`));
      return;
    }

    // ⏰ Task digest: DM opted-in users their Google Tasks due today.
    // Single-user test (ignores opt-in & time): /jobs/task-digest?key=…&email=…
    // Full run (opted-in, ALL hours):           /jobs/task-digest?key=…&confirm=1
    // Simulate one hour:                        …&confirm=1&hour=8
    if (req.params.job === 'task-digest') {
      if (req.query.email) {
        const summary = await runDailyTaskDigest(req.query.email);
        return res.send(`✅ ${summary}`);
      }
      if (req.query.confirm !== '1') {
        return res.status(400).send('Add &confirm=1 to run the digest for all opted-in users (optional &hour=8), or &email=… for a single test.');
      }
      const hour = req.query.hour !== undefined ? Number(req.query.hour) : null;
      const summary = await runDailyTaskDigest(null, hour);
      await postOps(summary);
      return res.send(`✅ ${summary}`);
    }

    return res.status(404).send('Unknown job. Use /jobs/weekly, /jobs/reminder, /jobs/broadcast, /jobs/dm-all, /jobs/announce-brain, /jobs/announce-tasks or /jobs/task-digest.');
  } catch (err) {
    console.error(`🚨 Manual job ${req.params.job} failed:`, err.message);
    return res.status(500).send(`❌ Job failed: ${err.message}`);
  }
});

// ---- 🔌 N8N inbound webhook (v2.10.0, header secret since v2.10.1) ----
// N8N workflows POST here with the connector code in the URL and the
// per-connection secret in the X-Kitten-Secret header. No Google auth on
// this route — code + secret are the credentials (validated against the
// central N8N sheet; unknown/unclaimed/revoked codes get a plain 404, a
// missing/wrong secret a 401, posts only ever go to the space stored at
// setup time, 20/min rate limit per code).
app.post('/n8n/:code', async (req, res) => {
  const r = await n8n.handleIncoming(req.params.code, req.body, req.headers['x-kitten-secret']);
  return res.status(r.status).send(r.text);
});

// Assemble the data for the 🔌 Automations dialog: this user's connections
// (with space names + their inbound URLs) and — for the setup dropdown —
// ONLY the spaces the USER is a member of too (v2.10.2 security measure:
// nobody gets to see, or bind reports to, spaces they don't belong to).
// allSpaces is used purely for labeling the user's existing connections.
async function automationsDialogData(email) {
  const [connections, allSpaces, userSpaces] = await Promise.all([
    n8n.listUserConnections(email).catch(err => { console.error('❌ n8n list failed:', err.message); return []; }),
    listKittenSpaces().catch(err => { console.error('❌ space list failed:', err.message); return []; }),
    listUserSpaces(email).catch(err => { console.error('❌ user-space list failed:', err.message); return []; })
  ]);
  const labelOf = id => allSpaces.find(s => s.id === id)?.label || id;
  return {
    connections: connections.map(c => ({
      row: c.row,
      name: c.name,
      created: c.created,
      spaceLabel: labelOf(c.spaceId),
      url: n8n.inboundUrl(c.code)
    })),
    spaces: userSpaces
  };
}

// ---- Slash command IDs (must match the Chat API console config) ----
const COMMANDS = {
  KITTEN: 1   // /kitten → help menu
};

// ---- Normalize both event formats into one shape ----
function normalizeEvent(body) {
  // NEW add-on format
  if (body.chat) {
    const c = body.chat;
    const common = body.commonEventObject || {};
    if (c.appCommandPayload) {
      return {
        isAddon: true,
        kind: 'command',
        commandId: Number(c.appCommandPayload.appCommandMetadata?.appCommandId),
        user: c.user
      };
    }
    if (c.messagePayload) {
      return { isAddon: true, kind: 'message', message: c.messagePayload.message, space: c.messagePayload.space, user: c.user };
    }
    if (c.buttonClickedPayload) {
      // Action name + extra params travel in commonEventObject.parameters
      // (can be a map {actionName: 'x'} or an array [{key,value}])
      const p = common.parameters;
      let params = {};
      if (Array.isArray(p)) p.forEach(e => { params[e.key] = e.value; });
      else if (p) params = p;
      return {
        isAddon: true,
        kind: 'click',
        fn: common.invokedFunction || params.actionName,
        params,
        formInputs: common.formInputs,
        isDialogEvent: !!c.buttonClickedPayload.isDialogEvent,
        user: c.user
      };
    }
    if (c.widgetUpdatedPayload) {
      // Autocomplete query from a MULTI_SELECT with external data source
      return {
        isAddon: true,
        kind: 'autocomplete',
        query: (common.parameters?.autocomplete_widget_query || '').trim(),
        user: c.user
      };
    }
    if (c.addedToSpacePayload) {
      return { isAddon: true, kind: 'added', space: c.addedToSpacePayload.space, user: c.user };
    }
    if (c.removedFromSpacePayload) {
      return { isAddon: true, kind: 'removed' };
    }
    // Fallback: some widget actions (e.g. onChangeAction) may arrive without a
    // known payload — route them by our actionName parameter if present.
    if (common.parameters?.actionName) {
      return {
        isAddon: true,
        kind: 'click',
        fn: common.parameters.actionName,
        params: common.parameters,
        formInputs: common.formInputs,
        user: c.user
      };
    }
    return { isAddon: true, kind: 'unknown' };
  }

  // Classic format (used by test/send-test-event.js)
  switch (body.type) {
    case 'MESSAGE': {
      const commandId = body.message?.slashCommand?.commandId;
      if (commandId !== undefined) return { isAddon: false, kind: 'command', commandId: Number(commandId), user: body.user };
      return { isAddon: false, kind: 'message', message: body.message, space: body.space, user: body.user };
    }
    case 'CARD_CLICKED':
      return {
        isAddon: false,
        kind: 'click',
        fn: body.common?.invokedFunction,
        formInputs: body.common?.formInputs,
        isDialogEvent: !!body.isDialogEvent,
        user: body.user
      };
    case 'ADDED_TO_SPACE':
      return { isAddon: false, kind: 'added', space: body.space, user: body.user };
    case 'REMOVED_FROM_SPACE':
      return { isAddon: false, kind: 'removed' };
    default:
      return { isAddon: false, kind: 'unknown', rawType: body.type };
  }
}

// ---- Main Chat event endpoint ----
app.post('/chat', chatAuthMiddleware(), async (req, res) => {
  const ev = normalizeEvent(req.body || {});
  const w = wrappers(ev.isAddon);
  // Does THIS user already have a Kitten Brain? (drives the menu button label)
  // Is THIS user a Kitten admin? (shows the 🛠️ Admin button)
  const [hasBrain, adminUser] = ev.user?.email
    ? await Promise.all([
        getBrain(ev.user.email).then(b => !!b).catch(() => false),
        isAdmin(ev.user.email).catch(() => false)
      ])
    : [false, false];
  console.log(`🐾 event kind=${ev.kind}${ev.fn ? ` fn=${ev.fn}` : ''}${ev.commandId ? ` command=${ev.commandId}` : ''}`);

  try {
    switch (ev.kind) {
      case 'added': {
        const text =
          ev.space?.type === 'DM' || ev.space?.singleUserBotDm
            ? 'Hi! 🐱 I am IT Kitten. Type *kitten* any time to see what I can help you with.'
            : `Thanks for adding me to *${ev.space?.displayName || 'this space'}*! 🐱 Mention me or use /kitten to get help.`;
        return res.json(w.newMessage({ text }));
      }

      case 'command': {
        switch (ev.commandId) {
          case COMMANDS.KITTEN:
            return res.json(w.newMessage(buildHelpMessage(undefined, [], hasBrain, adminUser)));
          default:
            return res.json(w.newMessage({ text: `Unknown command id: ${ev.commandId}` }));
        }
      }

      case 'message': {
        // Keyword trigger — like the Slack regex /^(kitty|kitten)$/i.
        // argumentText = text without the @mention, so it works in DMs and spaces.
        const rawText = (ev.message?.argumentText ?? ev.message?.text ?? '').trim();
        const text = rawText.toLowerCase();
        if (text === '' || text === 'kitty' || text === 'kitten' || text === 'help') {
          return res.json(w.newMessage(buildHelpMessage(undefined, [], hasBrain, adminUser)));
        }

        // ⏱️ One-off reminders
        // "my reminders" → list this user's open reminders
        if (/^(?:show\s+|list\s+)?my\s+reminders\s*$/i.test(rawText)) {
          const mine = await listOpenReminders(ev.user?.email).catch(() => []);
          if (!mine.length) {
            return res.json(w.newMessage({ text: '⏰ You have no open reminders. Try: *remind me in 2 hours to check the deploy*' }));
          }
          let text = '⏰ *Your open reminders:*\n';
          mine.forEach((r, i) => { text += `\n${i + 1}. ${fmtBerlin(r.dueMs)} — ${r.text}`; });
          text += `\n\n_To cancel one, write *cancel reminder* + its number from this list (e.g. *cancel reminder 1*) — or use the ⏱️ My reminders menu button._`;
          return res.json(w.newMessage({ text }));
        }

        // "cancel reminder N" → cancel the n-th open reminder
        const cancelMatch = rawText.match(/^cancel\s+reminder\s+(\d+)\s*$/i);
        if (cancelMatch) {
          const cancelled = await cancelReminder(ev.user?.email, Number(cancelMatch[1])).catch(() => null);
          return res.json(w.newMessage({
            text: cancelled
              ? `✅ Cancelled: "${cancelled.text}" (was due ${fmtBerlin(cancelled.dueMs)}). 🐾`
              : `⚠️ I couldn't find reminder #${cancelMatch[1]} — type *my reminders* to see the current numbers.`
          }));
        }

        // "remind me ..." → parse & store a one-off reminder
        if (/^remind\s+me\b/i.test(rawText)) {
          const parsed = parseReminder(rawText);
          if (!parsed) {
            return res.json(w.newMessage({
              text:
                '⏰ I didn\'t catch the time. Try one of these:\n' +
                '• *remind me in 30 minutes to check the deploy*\n' +
                '• *remind me at 15:30 to call BEM*\n' +
                '• *remind me tomorrow at 9 to submit the report*\n' +
                '• *remind me on friday to water the plants*\n' +
                '• *remind me on 24.12. at 10 to buy presents*'
            }));
          }
          const result = await addReminder(ev.user?.email, parsed.dueMs, parsed.text)
            .catch(err => { console.error('❌ reminder store failed:', err.message); return 'error'; });
          if (result === 'no_brain') {
            return res.json(w.newMessage({
              text: '🧠 Your reminders are stored privately in your Kitten Brain — and you don\'t have one yet! Type *kitten* and click *🧠 Create Kitten Brain*, then set your reminder again.'
            }));
          }
          if (result === 'past') return res.json(w.newMessage({ text: '⏰ That time is already in the past — try a future one. 😉' }));
          if (result === 'too_far') return res.json(w.newMessage({ text: '⏰ That\'s more than a year away — I can only remember reminders up to 1 year ahead.' }));
          if (result === 'too_long') return res.json(w.newMessage({ text: '⏰ That reminder text is too long — please keep it under 300 characters.' }));
          if (result === 'error') return res.json(w.newMessage({ text: '😿 I couldn\'t store the reminder right now. Please try again in a moment.' }));
          return res.json(w.newMessage({
            text: `⏰ Got it! I'll remind you on *${fmtBerlin(parsed.dueMs)}* (Berlin time): "${parsed.text}"\n_See them all with *my reminders*._ 🐾`
          }));
        }

        // 📅 "create a meeting" / "find a time" → offer the meeting planner
        // (dialogs can only open from a button click).
        if (/^(?:create|plan|schedule)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:meeting|event|call|termin)\b/i.test(rawText) ||
            /^find\s+(?:a\s+|me\s+a\s+)?(?:time|slot|meeting\s+time)\b/i.test(rawText)) {
          return res.json(w.newMessage(buildMeetingHubMessage()));
        }

        // 📝 "create me a task ..." → offer the task dialog (dialogs can only
        // open from a button click, so the reply carries a prefilled button).
        const taskMatch = rawText.match(/^create\s+(?:me\s+)?(?:a\s+)?task\b[:\s]*(?:for\s+)?(.*)$/i);
        if (taskMatch) {
          const settings = await getSettings(ev.user?.email).catch(() => null);
          if (settings && !settings.task_create) {
            return res.json(w.newMessage({
              text: '📝 Task creation is switched OFF in your settings. Type *kitten* → ⚙️ Settings to turn it back on.'
            }));
          }
          return res.json(w.newMessage(buildTaskOfferMessage((taskMatch[1] || '').trim())));
        }

        // 🧠 "remember ..." → store in THIS user's private Kitten Brain
        const remember = rawText.match(/^remember\b[:,]?\s*(.*)$/is);
        if (remember) {
          const fact = (remember[1] || '').replace(/^that\s+/i, '').trim();
          if (!fact) {
            return res.json(w.newMessage({ text: '🧠 What should I remember? Try: *remember I sit in the Berlin office*' }));
          }
          try {
            const result = await rememberFact(ev.user?.email, fact);
            if (result === 'no_brain') {
              return res.json(w.newMessage({
                text: '🧠 You don’t have a Kitten Brain yet! Type *kitten* and click *Create Kitten Brain* — then I can remember things just for you.'
              }));
            }
            return res.json(w.newMessage({ text: `🧠 Got it — stored in your Kitten Brain: "${fact}"` }));
          } catch (err) {
            console.error('❌ remember failed:', err.message);
            return res.json(w.newMessage({ text: '😿 I couldn’t reach your Kitten Brain right now. Please try again in a moment.' }));
          }
        }

        // 🧠 "forget ..." → memories are deleted by the USER, in their own sheet
        if (/^forget\b/i.test(rawText)) {
          const brain = await getBrain(ev.user?.email).catch(() => null);
          if (!brain) {
            return res.json(w.newMessage({ text: '🧠 You don’t have a Kitten Brain yet, so there’s nothing to forget. Type *kitten* to create one.' }));
          }
          return res.json(w.newMessage({
            text:
              '🧠 Your memories belong to YOU, so I don’t delete them myself. ' +
              'Open your memory sheet and simply delete the row(s) you want me to forget — ' +
              'I’ll notice within a minute: ' +
              `<https://docs.google.com/spreadsheets/d/${brain.sheetId}|Open my Kitten Brain sheet>`
          }));
        }

        // 🤖 Free text → Gemini (grounded in the FAQ knowledge base + the
        // user's PRIVATE Kitten Brain memories — theirs only, never others' —
        // plus the RAM-only short-term history of THIS conversation).
        // When Gemini flags an unresolved IT issue, the answer carries the
        // "🎫 Open a ticket for this" button and the AI-built draft (title,
        // description, steps already tried, suggested team) is cached for
        // the prefilled dialog. Env-gated: without VERTEX_PROJECT_ID the old
        // hint is shown.
        if (geminiEnabled()) {
          try {
            const email = ev.user?.email;
            const memories = await getMemories(email).catch(() => []);
            const history = getHistory(email);
            const { answer, ticket } = await askKitten({ question: rawText, userName: ev.user?.displayName, memories, history });
            pushHistory(email, 'user', rawText);
            pushHistory(email, 'model', answer);
            if (ticket) {
              storeTicketDraft(email, ticket);
              console.log(`🤖 Gemini answered with ticket offer (${rawText.slice(0, 60)}…) → team ${ticket.team}, "${ticket.title.slice(0, 60)}"`);
              return res.json(w.newMessage(buildTicketOfferAnswerMessage(answer)));
            }
            console.log(`🤖 Gemini answered (${rawText.slice(0, 60)}…) → ${answer.length} chars`);
            return res.json(w.newMessage({ text: answer }));
          } catch (err) {
            console.error('❌ Gemini failed:', err.response?.data?.error?.message || err.message);
            return res.json(w.newMessage({
              text: '😿 My AI brain is unavailable right now. Type *kitten* for the classic help menu, or try again in a moment.'
            }));
          }
        }
        return res.json(w.newMessage({ text: 'Meow! 🐱 Type *kitten* (or use /kitten) and I’ll show you what I can do.' }));
      }

      // Live FAQ autocomplete: return suggestion items for the dropdown
      case 'autocomplete': {
        let suggestions = [];
        if (ev.query.length >= 2) {
          try {
            const matches = await searchFAQs(ev.query);
            suggestions = matches.slice(0, 25).map(f => ({ text: f.suggestion, value: f.value }));
            // More than one hit → offer a "show all results" entry on top
            if (matches.length > 1) {
              suggestions.unshift({
                text: `📋 Show all ${matches.length} results for "${ev.query}"`,
                value: `__all__:${ev.query}`
              });
            }
            console.log(`🔎 autocomplete "${ev.query}" → ${suggestions.length} item(s)`);
          } catch (err) {
            console.error('❌ Autocomplete failed:', err.message);
          }
        }
        return res.json({
          action: {
            modifyOperations: [
              { updateWidget: { selectionInputWidgetSuggestions: { suggestions } } }
            ]
          }
        });
      }

      case 'click': {
        switch (ev.fn) {
          case 'trigger_faq_modal':
            return res.json(w.openDialog(buildFaqDialogCardObject()));

          // 🧠 Create the user's private Kitten Brain (folder + sheet + README
          // in THEIR OWN Drive) and answer with links to it.
          case 'create_brain': {
            const email = ev.user?.email;
            if (!email) {
              return res.json(w.updateMessage(buildHelpMessage('❌ Could not determine your email address.', [], hasBrain, adminUser)));
            }
            try {
              const brain = await createBrain(email);
              const linkButtons = [{
                buttonList: {
                  buttons: [
                    { text: '📂 Open Kitten Brain folder', onClick: { openLink: { url: brain.folderUrl } } },
                    { text: '📄 Open the memory sheet',    onClick: { openLink: { url: brain.sheetUrl } } }
                  ]
                }
              }];
              const header =
                '🧠 ✅ Your Kitten Brain is up and running! It lives in YOUR Google Drive and only you and I ' +
                'can see it. Start any message with *remember* (e.g. "remember I use a MacBook Pro") and I’ll ' +
                'keep it in mind when we talk. Please don’t delete the folder — that’s where my memory of you lives. 🐾';
              return res.json(w.updateMessage(buildHelpMessage(header, linkButtons, true, adminUser)));
            } catch (err) {
              console.error('❌ Kitten Brain creation failed:', err.response?.data?.error?.message || err.message);
              return res.json(w.updateMessage(buildHelpMessage(
                '😿 I couldn’t create your Kitten Brain. Please tell Marcus Gallein (IT) — the Drive access for the Kitten may not be set up yet.', [], hasBrain, adminUser)));
            }
          }

          // ⚙️ Settings dialog (Reminder + Meeting Settings, stored in the
          // user's Kitten Brain). 'open_reminder_settings' kept for old menu
          // cards that are still in users' chat histories.
          case 'open_settings':
          case 'open_reminder_settings': {
            if (!hasBrain) {
              return res.json(w.updateMessage(buildHelpMessage(
                '⚙️ Your settings live in your Kitten Brain — please click *🧠 Create Kitten Brain* first, then open the settings again.', [], hasBrain, adminUser)));
            }
            const settings = await getSettings(ev.user?.email);
            return res.json(w.openDialog(buildSettingsCardObject(settings, 'reminders')));
          }

          // settings side-nav switch (Reminder Settings <-> Meeting Settings)
          case 'settings_tab': {
            const settings = await getSettings(ev.user?.email).catch(() => ({}));
            const tab = ['reminders', 'meetings'].includes(ev.params?.tab) ? ev.params.tab : 'reminders';
            return res.json(w.updateDialog(buildSettingsCardObject(settings, tab)));
          }

          // 📅 Meeting Settings save (search window for find-a-time)
          case 'meeting_settings_submit': {
            const startRaw = parseInt(ev.formInputs?.meeting_start?.stringInputs?.value?.[0], 10);
            const endRaw = parseInt(ev.formInputs?.meeting_end?.stringInputs?.value?.[0], 10);
            const mStart = (!Number.isNaN(startRaw) && startRaw >= 0 && startRaw <= 23) ? startRaw : 9;
            const mEnd = (!Number.isNaN(endRaw) && endRaw >= 0 && endRaw <= 23) ? endRaw : 18;
            if (mEnd <= mStart) {
              return res.json(w.closeDialog('⚠️ "Search until" must be later than "Search from" — nothing was saved. Please try again.'));
            }
            // merge with CURRENT settings so the reminder toggles are untouched
            const cur = await getSettings(ev.user?.email).catch(() => null);
            const result = await setSettings(ev.user?.email, { ...(cur || {}), meeting_start: mStart, meeting_end: mEnd })
              .catch(err => { console.error('❌ meeting settings save failed:', err.message); return 'error'; });
            if (result === 'no_brain') {
              return res.json(w.closeDialog('⚠️ You need a Kitten Brain first — click 🧠 Create Kitten Brain in the menu.'));
            }
            if (result === 'error') {
              return res.json(w.closeDialog('😿 Could not save your settings. Please try again.'));
            }
            return res.json(w.closeDialog(
              `✅ Meeting settings saved — I'll search for free times between ${String(mStart).padStart(2, '0')}:00 and ${String(mEnd).padStart(2, '0')}:00 (Berlin time).`));
          }

          // ⏱️ My reminders dialog: list all open one-off reminders with a
          // Cancel button each (cancel re-renders the dialog with the rest).
          case 'open_my_reminders': {
            const mine = hasBrain ? await listOpenReminders(ev.user?.email).catch(() => []) : [];
            return res.json(w.openDialog(buildMyRemindersCardObject(
              mine.map(r => ({ row: r.row, when: fmtBerlin(r.dueMs), text: r.text })), hasBrain)));
          }

          case 'cancel_reminder_row': {
            const row = Number(ev.params?.row);
            if (row) {
              await cancelReminderByRow(ev.user?.email, row)
                .catch(err => console.error('❌ dialog cancel failed:', err.message));
            }
            const mine = hasBrain ? await listOpenReminders(ev.user?.email).catch(() => []) : [];
            return res.json(w.updateDialog(buildMyRemindersCardObject(
              mine.map(r => ({ row: r.row, when: fmtBerlin(r.dueMs), text: r.text })), hasBrain)));
          }

          case 'reminder_settings_submit': {
            const picked = ev.formInputs?.reminder_opts?.stringInputs?.value || [];
            const hourRaw = parseInt(ev.formInputs?.digest_hour?.stringInputs?.value?.[0], 10);
            const newHour = (!Number.isNaN(hourRaw) && hourRaw >= 0 && hourRaw <= 23) ? hourRaw : 8;
            // settings BEFORE saving — to detect the FIRST time the daily
            // task reminder is switched on (then we mention the reminder time)
            // and to keep the Meeting Settings untouched (merge, don't reset)
            const before = await getSettings(ev.user?.email).catch(() => null);
            const result = await setSettings(ev.user?.email, {
              ...(before || {}),
              reminders_enabled: picked.includes('reminders_enabled'),
              daily_tasks: picked.includes('daily_tasks'),
              morning_brief: picked.includes('morning_brief'),
              task_create: picked.includes('task_create'),
              digest_hour: newHour
            }).catch(err => { console.error('❌ settings save failed:', err.message); return 'error'; });
            if (result === 'no_brain') {
              return res.json(w.closeDialog('⚠️ You need a Kitten Brain first — click 🧠 Create Kitten Brain in the menu.'));
            }
            if (result === 'error') {
              return res.json(w.closeDialog('😿 Could not save your settings. Please try again.'));
            }
            // First time a daily reminder (tasks DM or day-brief) was enabled →
            // tell the user the current reminder time and where to change it.
            const firstEnable =
              (picked.includes('daily_tasks') && (!before || !before.daily_tasks)) ||
              (picked.includes('morning_brief') && (!before || !before.morning_brief));
            if (firstEnable) {
              return res.json(w.closeDialog(
                `✅ Saved! ⏰ Your daily reminder time is currently set to ${String(newHour).padStart(2, '0')}:00 Berlin time — ` +
                'you can change it any time: type *kitten* → ⚙️ Settings.'));
            }
            return res.json(w.closeDialog('✅ Reminder settings saved — stored in the SETTINGS tab of your Kitten Brain sheet.'));
          }

          // ❓ Overview of everything the Kitten can do + this user's setup
          // (tabbed dialog — the tab buttons re-render it via show_functions_tab)
          case 'show_functions': {
            const settings = await getSettings(ev.user?.email).catch(() => ({ reminders_enabled: true, daily_tasks: false, morning_brief: false, task_create: true, digest_hour: 8 }));
            return res.json(w.openDialog(buildFunctionsCardObject(settings, hasBrain, 'standard')));
          }

          case 'show_functions_tab': {
            const settings = await getSettings(ev.user?.email).catch(() => ({ reminders_enabled: true, daily_tasks: false, morning_brief: false, task_create: true, digest_hour: 8 }));
            const tab = ['standard', 'brain', 'reminders', 'commands'].includes(ev.params?.tab) ? ev.params.tab : 'standard';
            return res.json(w.updateDialog(buildFunctionsCardObject(settings, hasBrain, tab)));
          }

          // 🛠️ Admin area — only for emails in the "Admin access" tab of the
          // central sheet. Every send ALSO requires the security key (env
          // ADMIN_JOB_KEY) typed into the dialog.
          case 'open_admin': {
            if (!adminUser) {
              return res.json(w.updateMessage(buildHelpMessage(
                '⛔ The Admin area is only for registered Kitten admins.', [], hasBrain, adminUser)));
            }
            const jobs = Object.entries(ANNOUNCEMENTS).map(([value, a]) => ({ value, label: a.label }));
            return res.json(w.openDialog(buildAdminCardObject(jobs, 'dm-all', ANNOUNCEMENTS['dm-all'].text('{first name}'))));
          }

          // dropdown changed → re-render the dialog with the message preview
          case 'admin_select_job': {
            if (!adminUser) return res.json(w.closeDialog('⛔ Admins only.'));
            const sel = ev.formInputs?.admin_job?.stringInputs?.value?.[0];
            const job = ANNOUNCEMENTS[sel] ? sel : 'dm-all';
            const jobs = Object.entries(ANNOUNCEMENTS).map(([value, a]) => ({ value, label: a.label }));
            return res.json(w.updateDialog(buildAdminCardObject(jobs, job, ANNOUNCEMENTS[job].text('{first name}'))));
          }

          // send a prepared announcement to EVERYONE
          case 'admin_send_job': {
            if (!adminUser) return res.json(w.closeDialog('⛔ Admins only.'));
            const key = (ev.formInputs?.admin_key?.stringInputs?.value?.[0] || '').trim();
            if (!process.env.ADMIN_JOB_KEY || key !== process.env.ADMIN_JOB_KEY) {
              return res.json(w.closeDialog('⛔ Wrong security key — nothing was sent.'));
            }
            const sel = ev.formInputs?.admin_job?.stringInputs?.value?.[0];
            const job = ANNOUNCEMENTS[sel];
            if (!job) return res.json(w.closeDialog('⚠️ Please pick a message first.'));
            console.log(`🛠️ Admin ${ev.user?.email} sends "${sel}" to everyone.`);
            dmEveryone(job.label, job.text)
              .catch(err => postOps(`🚨 *Admin send (${sel}) crashed:* ${err.message}`));
            return res.json(w.closeDialog(`🚀 Sending "${job.label}" to everyone in the background — summary goes to the ops space.`));
          }

          // send a CUSTOM broadcast to EVERYONE
          case 'admin_send_custom': {
            if (!adminUser) return res.json(w.closeDialog('⛔ Admins only.'));
            const key = (ev.formInputs?.admin_key2?.stringInputs?.value?.[0] || '').trim();
            if (!process.env.ADMIN_JOB_KEY || key !== process.env.ADMIN_JOB_KEY) {
              return res.json(w.closeDialog('⛔ Wrong security key — nothing was sent.'));
            }
            const msg = (ev.formInputs?.admin_custom_msg?.stringInputs?.value?.[0] || '').trim();
            if (!msg) return res.json(w.closeDialog('⚠️ The message was empty — nothing was sent.'));
            console.log(`🛠️ Admin ${ev.user?.email} sends a custom broadcast to everyone.`);
            dmEveryone('📢 Custom broadcast', () => `📢 *Announcement from USC IT:*\n\n${msg}`)
              .catch(err => postOps(`🚨 *Admin custom broadcast crashed:* ${err.message}`));
            return res.json(w.closeDialog('🚀 Sending your broadcast to everyone in the background — summary goes to the ops space.'));
          }

          // send a test DM to ONE person only
          case 'admin_send_test': {
            if (!adminUser) return res.json(w.closeDialog('⛔ Admins only.'));
            const key = (ev.formInputs?.admin_test_key?.stringInputs?.value?.[0] || '').trim();
            if (!process.env.ADMIN_JOB_KEY || key !== process.env.ADMIN_JOB_KEY) {
              return res.json(w.closeDialog('⛔ Wrong security key — nothing was sent.'));
            }
            const email = (ev.formInputs?.admin_test_email?.stringInputs?.value?.[0] || '').trim();
            const msg = (ev.formInputs?.admin_test_msg?.stringInputs?.value?.[0] || '').trim();
            if (!email || !email.includes('@') || !msg) {
              return res.json(w.closeDialog('⚠️ Please fill in a valid tester email AND a message — nothing was sent.'));
            }
            try {
              const ok = await sendDm(email, msg);
              return res.json(w.closeDialog(ok
                ? `✅ Test DM sent to ${email}.`
                : `❌ Could not DM ${email} — no DM channel with the Kitten yet?`));
            } catch (err) {
              console.error('❌ Admin test DM failed:', err.message);
              return res.json(w.closeDialog(`❌ Test DM failed: ${err.message}`));
            }
          }

          // 🔌 Automations dialog (N8N → space reports, v2.10.0)
          case 'open_automations': {
            if (!n8n.isConfigured()) {
              return res.json(w.updateMessage(buildHelpMessage(
                '🔌 Automations are not available yet — the N8N connections sheet is not configured. Please tell Marcus Gallein (IT).', [], hasBrain, adminUser)));
            }
            const data = await automationsDialogData(ev.user?.email);
            // no connections yet → open straight on the setup tab
            return res.json(w.openDialog(buildAutomationsCardObject(data, data.connections.length ? 'existing' : 'setup')));
          }

          case 'automations_tab': {
            const data = await automationsDialogData(ev.user?.email);
            const tab = ['existing', 'setup'].includes(ev.params?.tab) ? ev.params.tab : 'existing';
            return res.json(w.updateDialog(buildAutomationsCardObject(data, tab)));
          }

          // 🗑️ revoke one of the user's own connections (marks the row, never deletes)
          case 'n8n_revoke': {
            const row = Number(ev.params?.row);
            if (row) {
              await n8n.revokeByRow(row, ev.user?.email)
                .catch(err => console.error('❌ n8n revoke failed:', err.message));
            }
            const data = await automationsDialogData(ev.user?.email);
            return res.json(w.updateDialog(buildAutomationsCardObject(data, 'existing')));
          }

          // ➕ claim a connector code and establish the connection
          case 'n8n_setup_submit': {
            const code = (ev.formInputs?.n8n_code?.stringInputs?.value?.[0] || '').trim();
            const name = (ev.formInputs?.n8n_name?.stringInputs?.value?.[0] || '').trim().slice(0, 60);
            const link = (ev.formInputs?.n8n_link?.stringInputs?.value?.[0] || '').trim();
            const spaceId = ev.formInputs?.n8n_space?.stringInputs?.value?.[0] || '';
            const email = ev.user?.email;
            if (!email) return res.json(w.closeDialog('❌ Could not determine your email address — nothing was connected.'));
            if (!code || !name || !link || !spaceId) {
              return res.json(w.closeDialog('⚠️ Please fill in the code, a name, the N8N link AND pick a space — nothing was connected.'));
            }
            if (!/^https?:\/\//i.test(link)) {
              return res.json(w.closeDialog('⚠️ The N8N link must be a URL (https://…) — nothing was connected.'));
            }
            try {
              // v2.10.2 security check — the dropdown already only OFFERS the
              // user's own spaces, but the submit value could be forged, so
              // membership is verified independently here (fail-closed).
              const member = await isSpaceMember(spaceId, email);
              if (!member) {
                return res.json(w.closeDialog('⛔ You can only connect spaces you are a member of yourself — nothing was connected.'));
              }
              const result = await n8n.claimCode({ code, link, spaceId, email, name });
              if (result === 'bad_code') {
                return res.json(w.closeDialog('⛔ That connector code is not valid. Codes come from IT — ask in #it-support.'));
              }
              if (result === 'claimed') {
                return res.json(w.closeDialog('⛔ That connector code was already used — each code works exactly once. Ask IT for a fresh one.'));
              }
              const spaces = await listKittenSpaces().catch(() => []);
              const spaceLabel = spaces.find(s => s.id === spaceId)?.label || spaceId;
              await postMessageToSpace(spaceId, {
                text: `🔌 ✅ *${name}* — this space is now connected to an N8N workflow via the Kitten (set up by ${email}). Reports will appear here.`
              }).catch(err => console.error('❌ n8n test post failed:', err.message));
              // v2.10.3: the secret is NOT posted into the chat — it is parked
              // in RAM for the one-time "🔐 Reveal secret" popup.
              storePendingSecret(email, name, result.secret);
              console.log(`🔌 N8N connection "${name}" established by ${email} → ${spaceId}`);
              return res.json(w.newMessage(buildN8nConnectedMessage(name, n8n.inboundUrl(code), spaceLabel)));
            } catch (err) {
              console.error('❌ n8n setup failed:', err.message);
              return res.json(w.closeDialog('😿 Something went wrong connecting — please try again or tell Marcus Gallein (IT).'));
            }
          }

          // 🔐 One-time secret reveal (v2.10.3): opens an EPHEMERAL dialog —
          // dialogs are never stored in the chat history. takePendingSecret
          // deletes on read, so this works exactly once per connection.
          case 'n8n_reveal_secret': {
            const pending = takePendingSecret(ev.user?.email);
            return res.json(w.openDialog(buildSecretRevealCardObject(pending?.name, pending?.secret)));
          }

          // 🛠️ Admin: generate a fresh single-use connector code
          case 'admin_n8n_code': {
            if (!adminUser) return res.json(w.closeDialog('⛔ Admins only.'));
            const key = (ev.formInputs?.admin_n8n_key?.stringInputs?.value?.[0] || '').trim();
            if (!process.env.ADMIN_JOB_KEY || key !== process.env.ADMIN_JOB_KEY) {
              return res.json(w.closeDialog('⛔ Wrong security key — no code was generated.'));
            }
            if (!n8n.isConfigured()) {
              return res.json(w.closeDialog('⚠️ N8N_SHEET_ID is not set on the server — create the sheet first (see docs).'));
            }
            try {
              const code = await n8n.generateCode();
              console.log(`🔌 Admin ${ev.user?.email} generated an N8N connector code.`);
              return res.json(w.newMessage(buildN8nCodeMessage(code)));
            } catch (err) {
              console.error('❌ n8n code generation failed:', err.message);
              return res.json(w.closeDialog(`❌ Could not write to the N8N sheet: ${err.message}`));
            }
          }

          // 📅 Meeting planner dialog (Create event / Find a time) —
          // slot buttons reopen it with startMs/duration/guests prefilled
          case 'open_meeting_planner': {
            const settings = await getSettings(ev.user?.email).catch(() => ({ meeting_start: 9, meeting_end: 18 }));
            const tab = ['create', 'find'].includes(ev.params?.tab) ? ev.params.tab : 'create';
            // The Chat date/time picker displays its value as if the ms were
            // UTC wall clock — so a TRUE epoch (slot buttons) must be turned
            // into "Berlin wall clock encoded as UTC" for the prefill.
            let pickerMs;
            if (ev.params?.startMs) {
              const bp = berlinParts(Number(ev.params.startMs));
              pickerMs = Date.UTC(bp.y, bp.m - 1, bp.d, bp.hh, bp.mm);
            }
            const prefill = {
              startMs: pickerMs,
              duration: ev.params?.duration ? Number(ev.params.duration) : undefined,
              guests: ev.params?.guests || ''
            };
            return res.json(w.openDialog(buildMeetingPlannerCardObject(settings, tab, prefill)));
          }

          case 'meeting_planner_tab': {
            const settings = await getSettings(ev.user?.email).catch(() => ({ meeting_start: 9, meeting_end: 18 }));
            const tab = ['create', 'find'].includes(ev.params?.tab) ? ev.params.tab : 'create';
            return res.json(w.updateDialog(buildMeetingPlannerCardObject(settings, tab)));
          }

          // 📅 create the calendar event (user's own calendar, auto Meet link)
          case 'event_create_submit': {
            const title = (ev.formInputs?.event_title?.stringInputs?.value?.[0] || '').trim();
            // The picker's msSinceEpoch is the picked WALL-CLOCK time encoded
            // as if it were UTC (NOT a true epoch). Reinterpret it as Berlin
            // wall clock -> true epoch, otherwise events land 1-2 h late.
            const rawStart = Number(ev.formInputs?.event_start?.dateTimeInput?.msSinceEpoch);
            let startMs = NaN;
            if (rawStart && !Number.isNaN(rawStart)) {
              const p = new Date(rawStart);
              startMs = berlinToUtcMs(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate(), p.getUTCHours(), p.getUTCMinutes());
            }
            const durationMin = parseInt(ev.formInputs?.event_duration?.stringInputs?.value?.[0], 10) || 60;
            const guests = parseGuests(ev.formInputs?.event_guests?.stringInputs?.value?.[0]);
            const description = (ev.formInputs?.event_desc?.stringInputs?.value?.[0] || '').trim();
            if (!title) return res.json(w.closeDialog('⚠️ Please give the event a title — nothing was created.'));
            if (!startMs || Number.isNaN(startMs)) return res.json(w.closeDialog('⚠️ Please pick a start date & time — nothing was created.'));
            if (startMs < Date.now()) return res.json(w.closeDialog('⚠️ The start time is in the past — nothing was created. Please try again.'));
            try {
              const evt = await createEvent(ev.user?.email, { title, startMs, durationMin, guests, description });
              const buttons = [];
              if (evt.htmlLink) buttons.push({ text: '📅 Open in Calendar', onClick: { openLink: { url: evt.htmlLink } } });
              if (evt.meetLink) buttons.push({ text: '🎥 Join Google Meet', onClick: { openLink: { url: evt.meetLink } } });
              return res.json(w.newMessage({
                text: '📅 Event created',
                cardsV2: [{
                  cardId: 'event_created',
                  card: {
                    sections: [{
                      widgets: [
                        {
                          textParagraph: {
                            text:
                              `📅 <b>${title}</b> is in your calendar!\n` +
                              `${berlinDay(startMs)}, ${berlinHHMM(startMs)} – ${berlinHHMM(evt.endMs)} (Berlin)` +
                              `${guests.length ? `\n✉️ Invitations sent to ${guests.length} guest${guests.length > 1 ? 's' : ''}.` : ''}` +
                              `${evt.meetLink ? '\n🎥 Google Meet link attached.' : ''}`
                          }
                        },
                        ...(buttons.length ? [{ buttonList: { buttons } }] : [])
                      ]
                    }]
                  }
                }]
              }));
            } catch (err) {
              console.error('❌ Event creation failed:', err.response?.data?.error?.message || err.message);
              return res.json(w.closeDialog('😿 I couldn\'t create the event. Please tell Marcus Gallein (IT) — the Calendar write access may not be set up yet.'));
            }
          }

          // 🔎 find free meeting times (free/busy of all guests) —
          // range 'day' = up to 3 slots on that day (default);
          // range 'week' = Mon–Fri of the week containing the picked date,
          // best slot per day (past days skipped), one freebusy call.
          case 'findtime_submit': {
            const dateMs = Number(ev.formInputs?.find_date?.dateInput?.msSinceEpoch);
            const durationMin = parseInt(ev.formInputs?.find_duration?.stringInputs?.value?.[0], 10) || 60;
            const guests = parseGuests(ev.formInputs?.find_guests?.stringInputs?.value?.[0]);
            const range = ev.formInputs?.find_range?.stringInputs?.value?.[0] === 'week' ? 'week' : 'day';
            if (!dateMs || Number.isNaN(dateMs)) return res.json(w.closeDialog('⚠️ Please pick a day to search.'));
            const day = new Date(dateMs);
            const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
            const settings = await getSettings(ev.user?.email).catch(() => ({ meeting_start: 9, meeting_end: 18 }));
            const winFrom = String(settings.meeting_start ?? 9).padStart(2, '0');
            const winTo = String(settings.meeting_end ?? 18).padStart(2, '0');
            try {
              const args = {
                y, m: mo, d, durationMin, guests,
                windowStartH: settings.meeting_start ?? 9,
                windowEndH: settings.meeting_end ?? 18
              };
              const result = range === 'week'
                ? await findFreeSlotsWeek(ev.user?.email, { ...args, maxSlots: 5 })
                : await findFreeSlots(ev.user?.email, { ...args, maxSlots: 3 });
              const { slots, unreadable } = result;

              let header;
              if (range === 'week') {
                const ws = result.weekStart, we = result.weekEnd;
                const wsMs = Date.UTC(ws.y, ws.m - 1, ws.d, 12), weMs = Date.UTC(we.y, we.m - 1, we.d, 12);
                header = `🔎 <b>${durationMin}-minute meeting in the week ${berlinDayShort(wsMs)} – ${berlinDayShort(weMs)}</b> — you + ${guests.length} guest${guests.length === 1 ? '' : 's'}:\n`;
              } else {
                header = `🔎 <b>${durationMin}-minute meeting on ${berlinDay(slots[0] ?? dateMs)}</b> — you + ${guests.length} guest${guests.length === 1 ? '' : 's'}:\n`;
              }
              if (unreadable.length) {
                header += `\n⚠️ I can't read the calendar${unreadable.length > 1 ? 's' : ''} of <b>${unreadable.join(', ')}</b> (external or restricted) — the times below fit everyone else.\n`;
              }
              if (!slots.length) {
                header += `\n😿 No slot where everyone is free between ${winFrom}:00 and ${winTo}:00${range === 'week' ? ' on any day of that week' : ''}. Try another ${range === 'week' ? 'week' : 'day'}, a shorter meeting, or widen your window under ⚙️ Settings → 📅 Meeting Settings.`;
              } else if (range === 'week') {
                header += `\n✅ <b>One suggestion per day</b> — the earliest slot where everyone${unreadable.length ? ' (readable)' : ''} is free:`;
                header += `\n<font color="#80868B">ℹ️ Days without a button have no common free slot. Need more options on one of these days? Run the search again with 📅 "Only this day".</font>`;
              } else {
                header += `\n✅ Everyone${unreadable.length ? ' (readable)' : ''} is free at:`;
              }
              const slotItems = slots.map(s => ({
                startMs: s,
                label: range === 'week'
                  ? `${berlinDayShort(s)} · ${berlinHHMM(s)} – ${berlinHHMM(s + durationMin * 60000)}`
                  : `${berlinHHMM(s)} – ${berlinHHMM(s + durationMin * 60000)}`
              }));
              return res.json(w.newMessage(buildFindTimeResultsMessage(header, slotItems, durationMin, guests.join(', '))));
            } catch (err) {
              console.error('❌ Find-a-time failed:', err.response?.data?.error?.message || err.message);
              return res.json(w.closeDialog('😿 I couldn\'t check the calendars. Please tell Marcus Gallein (IT) — the Calendar access may not be set up yet.'));
            }
          }

          // 📝 Task dialog (prefilled from the chat message) + creation
          case 'open_task_modal':
            return res.json(w.openDialog(buildTaskDialogCardObject(ev.params?.prefill || '')));

          case 'task_dialog_submit': {
            const title = (ev.formInputs?.task_title?.stringInputs?.value?.[0] || '').trim();
            if (!title) {
              return res.json(w.closeDialog('⚠️ The task text was empty — nothing was created. Please try again.'));
            }
            const dueMs = ev.formInputs?.task_due?.dateInput?.msSinceEpoch;
            try {
              await createTask(ev.user?.email, title, dueMs);
              const dueTxt = dueMs ? ` (due ${new Date(Number(dueMs)).toISOString().slice(0, 10)})` : '';
              return res.json(w.newMessage({ text: `✅ Task created in your Google Tasks: "${title}"${dueTxt} 📝` }));
            } catch (err) {
              console.error('❌ Task creation failed:', err.response?.data?.error?.message || err.message);
              return res.json(w.closeDialog('😿 I couldn’t create the task. Please tell Marcus Gallein (IT) — the Tasks access may not be set up yet.'));
            }
          }

          // 🎫 Jira ticket dialog (ported from Slack's open_jira_modal)
          case 'open_jira_modal':
            return res.json(w.openDialog(buildJiraDialogCardObject()));

          // 🎫 "Open a ticket for this" (v2.9.0): open the Jira dialog
          // PREFILLED with the AI draft cached for this user — title,
          // description + steps already tried, suggested team preselected.
          // Draft gone (expired / server restarted)? Open the empty dialog
          // with a friendly note instead of failing.
          case 'open_ticket_draft': {
            const draft = takeTicketDraft(ev.user?.email);
            if (!draft) {
              return res.json(w.openDialog(buildJiraDialogCardObject({
                note: '⚠️ My draft of your issue expired — please fill in the details again (sorry!).'
              })));
            }
            const description =
              `${draft.description}` +
              `${draft.steps_tried && draft.steps_tried !== 'None yet' ? `\n\nAlready tried without success:\n${draft.steps_tried}` : ''}`;
            return res.json(w.openDialog(buildJiraDialogCardObject({
              team: draft.team,
              title: draft.title,
              description,
              note: '🤖 Prefilled from our chat — please check the team and adjust anything before creating.'
            })));
          }

          case 'jira_dialog_submit': {
            const title = (ev.formInputs?.jira_title?.stringInputs?.value?.[0] || '').trim();
            const description = (ev.formInputs?.jira_desc?.stringInputs?.value?.[0] || '').trim();
            const projectKey = ev.formInputs?.jira_project?.stringInputs?.value?.[0] || 'IH';
            const reporterEmail = ev.user?.email;

            if (!title || !description) {
              return res.json(w.closeDialog('⚠️ Please fill in title AND description — no ticket was created. Please try again.'));
            }

            try {
              const ticket = await createJiraTicket({ title, description, reporterEmail, projectKey });
              // webUrl comes from Jira.js: JSM desks (IH, SECHELP) get the
              // customer-portal request view, plain projects get /browse/KEY
              ticketDrafts.delete(reporterEmail); // draft used up (if there was one)
              console.log(`🎫 Jira ticket created: ${ticket.key} (${projectKey}) by ${reporterEmail}`);
              return res.json(w.newMessage(buildTicketCreatedMessage(ticket.key, ticket.webUrl)));
            } catch (err) {
              console.error('❌ Jira ticket creation failed:', err.response?.data || err.message);
              return res.json(w.closeDialog('❌ Failed to create the Jira ticket. Please try again or contact IT.'));
            }
          }

          // 📋 My Open Jira Tickets (ported from Jira-MyTickets.js) — paginated
          case 'option_6': {
            const email = ev.user?.email;
            if (!email) {
              return res.json(w.updateMessage(buildHelpMessage('❌ Could not determine your email address.', [], hasBrain, adminUser)));
            }
            try {
              const requestedPage = Number(ev.params?.page || 0);
              const tickets = await getUserOpenTickets(email);
              const { text, page, totalPages } = buildMyTicketsPage(tickets, requestedPage);
              console.log(`📋 My tickets for ${email}: ${tickets.length} (page ${page + 1}/${totalPages})`);

              // ⬅️ / ➡️ pagination buttons
              const navButtons = [];
              if (page > 0) {
                navButtons.push({
                  text: '⬅️ Previous',
                  onClick: buttonAction('option_6', false, [{ key: 'page', value: String(page - 1) }])
                });
              }
              if (page < totalPages - 1) {
                navButtons.push({
                  text: '➡️ Next page',
                  onClick: buttonAction('option_6', false, [{ key: 'page', value: String(page + 1) }])
                });
              }
              const extraWidgets = navButtons.length ? [{ buttonList: { buttons: navButtons } }] : [];

              return res.json(w.updateMessage(buildHelpMessage(text, extraWidgets, hasBrain, adminUser)));
            } catch (err) {
              console.error('❌ Fetching tickets failed:', err.response?.data || err.message);
              return res.json(w.updateMessage(buildHelpMessage('❌ Sorry, I couldn’t fetch your Jira tickets. Please try again later.', [], hasBrain, adminUser)));
            }
          }

          // 🔎 FAQ search: read the query from the card's search field
          case 'faq_search': {
            const query = (ev.formInputs?.faq_query?.stringInputs?.value?.[0] || '').trim();
            if (query.length < 2) {
              return res.json(w.updateMessage(buildHelpMessage('Please type at least 2 characters into the search field. 🔎', [], hasBrain, adminUser)));
            }
            try {
              const matches = await searchFAQs(query);
              console.log(`🔎 FAQ search "${query}" → ${matches.length} match(es)`);
              return res.json(w.updateMessage(buildFaqResultsMessage(query, matches, hasBrain, adminUser)));
            } catch (err) {
              console.error('❌ FAQ search failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ search is unavailable right now. Please tell Marcus Gallein.', [], hasBrain, adminUser)));
            }
          }

          // 🔽 User picked entries in the autocomplete dropdown
          case 'faq_selected': {
            try {
              const values = ev.formInputs?.faq_select?.stringInputs?.value || [];
              console.log(`🔽 FAQ selected: ${values.join(', ') || '(none)'}`);

              // "Show all results" pseudo-entry picked → list all matches
              const allSel = values.find(v => v.startsWith('__all__:'));
              if (allSel) {
                const query = allSel.slice('__all__:'.length);
                const matches = await searchFAQs(query);
                return res.json(w.updateMessage(buildFaqResultsMessage(query, matches, hasBrain, adminUser)));
              }

              const faqs = (await Promise.all(values.map(v => findFAQ(v)))).filter(Boolean);
              if (!faqs.length) return res.json(w.updateMessage(buildHelpMessage(undefined, [], hasBrain, adminUser)));

              const response = w.updateMessage(buildSelectionMessage(faqs, hasBrain, adminUser));
              if (process.env.ENABLE_DEBUG_EVENTS === '1') console.log('📤 RESPONSE:', JSON.stringify(response).slice(0, 500));
              return res.json(response);
            } catch (err) {
              console.error('❌ FAQ selection failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ lookup failed. Please tell Marcus Gallein.', [], hasBrain, adminUser)));
            }
          }

          // 💡 FAQ answer: user clicked one of the search results
          case 'faq_answer': {
            try {
              const faq = await findFAQ(ev.params?.faq_value);
              const responseText = faq?.responseText || 'Hmm. I’m not sure how to help with that yet. 💥';
              return res.json(w.updateMessage(buildAnswerMessage(responseText, hasBrain, adminUser)));
            } catch (err) {
              console.error('❌ FAQ lookup failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ lookup failed. Please tell Marcus Gallein.', [], hasBrain, adminUser)));
            }
          }

          case 'faq_dialog_submit': {
            const title = (ev.formInputs?.faq_title?.stringInputs?.value?.[0] || '').trim();
            const helptext = (ev.formInputs?.faq_helptext?.stringInputs?.value?.[0] || '').trim();
            const requester = ev.user?.displayName || ev.user?.email || 'unknown';

            if (!title || !helptext) {
              return res.json(w.closeDialog('⚠️ Please fill in both fields — your FAQ was NOT saved. Open the dialog and try again.'));
            }

            try {
              await appendFAQToSheet(title, helptext, requester);
              console.log(`✅ FAQ saved to sheet: "${title}" by ${requester}`);
              return res.json(w.closeDialog(`✅ Your FAQ was submitted: "${title}" — thanks, ${requester}!`));
            } catch (err) {
              console.error('❌ Failed to write FAQ to sheet:', err.message);
              return res.json(w.closeDialog('⚠️ Something went wrong saving your FAQ. Please tell Marcus Gallein.'));
            }
          }

          // All other menu buttons → update the message with (placeholder) answer + menu
          default:
            return res.json(w.updateMessage(buildAnswerMessage(answerTextFor(ev.fn), hasBrain, adminUser)));
        }
      }

      case 'removed':
        console.log('ℹ️ Removed from a space.');
        return res.json({});

      default:
        console.log('ℹ️ Unhandled event:', JSON.stringify(req.body).slice(0, 300));
        return res.json({});
    }
  } catch (err) {
    console.error('🚨 Error handling Chat event:', err);
    return res.json(w.newMessage({ text: '❌ Something went wrong. Please tell Marcus Gallein.' }));
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡️ google-it-kitten foundation is listening on port ${PORT}`);
});

module.exports = app; // exported for tests
