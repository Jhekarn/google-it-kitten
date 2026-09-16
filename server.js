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
  buildReminderSettingsCardObject,
  buildFunctionsCardObject,
  buildTaskDialogCardObject,
  buildTaskOfferMessage,
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
const { postOps, postToSpace: postToSpaceViaPoster, sendDm, getUserInfo, listDomainUsers } = require('./Chat-Poster');
const { askGemini, isEnabled: geminiEnabled } = require('./Gemini-Handler');
const { createBrain, rememberFact, getMemories, getBrain, getSettings, setSettings } = require('./Kitten-Brain');
const { createTask, runDailyTaskDigest } = require('./Kitten-Tasks');

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

// Daily 08:00 Berlin time (DST-safe via timezone option): DM opted-in users
// their Google Tasks due today. Only users who enabled it in ⏰ Reminder settings.
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Running daily task digest...');
  try {
    const summary = await runDailyTaskDigest();
    await postOps(summary);
  } catch (err) {
    console.error('🚨 Task digest failed:', err.message);
    await postOps(`🚨 *Daily task digest failed:* ${err.message}`);
  }
}, { timezone: 'Europe/Berlin' });

const app = express();
app.use(express.json());

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
    if (req.params.job === 'dm-all') {
      const messageFor = (firstName) =>
        `Hey psst ${firstName || 'there'} 🐱 ...don't tell anyone, but you can also *chat with me* ` +
        `to assist you — just send me any IT question right here. Maybe give it a try? 😉`;

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

      const users = await listDomainUsers();
      res.send(`🚀 Started: DMing ${users.length} users in the background. A summary will be posted to the ops space.`);

      // Continue in the background — don't block the HTTP response.
      (async () => {
        let sent = 0, noDm = 0, failed = 0;
        for (const u of users) {
          try {
            (await sendDm(u.email, messageFor(u.firstName))) ? sent++ : noDm++;
          } catch (err) {
            console.warn(`⚠️ dm-all: ${u.email} failed: ${err.message}`);
            failed++;
          }
          await new Promise(r => setTimeout(r, 250)); // stay well under Chat API quotas
        }
        const summary = `🤫 *DM-all finished:* ${sent} sent · ${noDm} without DM channel · ${failed} failed (of ${users.length} users).`;
        console.log(summary);
        await postOps(summary);
      })().catch(err => postOps(`🚨 *DM-all crashed:* ${err.message}`));
      return;
    }

    // 🧠 Announce the Kitten Brain feature to every user (DM, personalized).
    // Single-user test:   /jobs/announce-brain?key=…&email=someone@urbansportsclub.com
    // Full run (everyone): /jobs/announce-brain?key=…&confirm=1
    if (req.params.job === 'announce-brain') {
      const messageFor = (firstName) =>
        `Hey ${firstName || 'there'} 🧠 I learned a new trick — I can now *remember things, just for you*!\n\n` +
        `Type *kitten* and click *🧠 Create Kitten Brain*. From then on, start any message with ` +
        `*remember* (e.g. "remember I use a MacBook Pro") and I’ll keep it in mind whenever we chat. ` +
        `To make me forget something, just open your memory sheet and delete the row.\n\n` +
        `🔒 Your memories live in YOUR own Google Drive — nobody else can see them, ` +
        `and they’re only ever used in your own conversations with me. 🐾`;

      // Test mode: one user only
      if (req.query.email) {
        const info = await getUserInfo(req.query.email);
        const ok = await sendDm(req.query.email, messageFor(info?.firstName));
        return res.send(ok
          ? `✅ Test announcement sent to ${req.query.email}${info?.firstName ? ` (as "${info.firstName}")` : ''}.`
          : `❌ Could not DM ${req.query.email} — no DM channel with the Kitten yet?`);
      }

      // Safety: the full run must be confirmed explicitly
      if (req.query.confirm !== '1') {
        return res.status(400).send(
          'This would DM EVERY user in the domain. Add &confirm=1 to really run it, or &email=someone@… for a single test.');
      }

      const users = await listDomainUsers();
      res.send(`🚀 Started: announcing the Kitten Brain to ${users.length} users in the background. Summary goes to the ops space.`);

      (async () => {
        let sent = 0, noDm = 0, failed = 0;
        for (const u of users) {
          try {
            (await sendDm(u.email, messageFor(u.firstName))) ? sent++ : noDm++;
          } catch (err) {
            console.warn(`⚠️ announce-brain: ${u.email} failed: ${err.message}`);
            failed++;
          }
          await new Promise(r => setTimeout(r, 250)); // stay well under Chat API quotas
        }
        const summary = `🧠 *Kitten Brain announcement finished:* ${sent} sent · ${noDm} without DM channel · ${failed} failed (of ${users.length} users).`;
        console.log(summary);
        await postOps(summary);
      })().catch(err => postOps(`🚨 *announce-brain crashed:* ${err.message}`));
      return;
    }

    // ⏰ Task digest: DM opted-in users their Google Tasks due today.
    // Single-user test (ignores their opt-in): /jobs/task-digest?key=…&email=…
    // Full run (opted-in users only):          /jobs/task-digest?key=…&confirm=1
    if (req.params.job === 'task-digest') {
      if (req.query.email) {
        const summary = await runDailyTaskDigest(req.query.email);
        return res.send(`✅ ${summary}`);
      }
      if (req.query.confirm !== '1') {
        return res.status(400).send('Add &confirm=1 to run the digest for all opted-in users, or &email=… for a single test.');
      }
      const summary = await runDailyTaskDigest();
      await postOps(summary);
      return res.send(`✅ ${summary}`);
    }

    return res.status(404).send('Unknown job. Use /jobs/weekly, /jobs/reminder, /jobs/broadcast, /jobs/dm-all, /jobs/announce-brain or /jobs/task-digest.');
  } catch (err) {
    console.error(`🚨 Manual job ${req.params.job} failed:`, err.message);
    return res.status(500).send(`❌ Job failed: ${err.message}`);
  }
});

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
  const hasBrain = ev.user?.email ? !!(await getBrain(ev.user.email).catch(() => null)) : false;
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
            return res.json(w.newMessage(buildHelpMessage(undefined, [], hasBrain)));
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
          return res.json(w.newMessage(buildHelpMessage(undefined, [], hasBrain)));
        }

        // 📝 "create me a task ..." → offer the task dialog (dialogs can only
        // open from a button click, so the reply carries a prefilled button).
        const taskMatch = rawText.match(/^create\s+(?:me\s+)?(?:a\s+)?task\b[:\s]*(?:for\s+)?(.*)$/i);
        if (taskMatch) {
          const settings = await getSettings(ev.user?.email).catch(() => null);
          if (settings && !settings.task_create) {
            return res.json(w.newMessage({
              text: '📝 Task creation is switched OFF in your settings. Type *kitten* → ⏰ Reminder settings to turn it back on.'
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
        // user's PRIVATE Kitten Brain memories — theirs only, never others').
        // Feature is env-gated: without VERTEX_PROJECT_ID the old hint is shown.
        if (geminiEnabled()) {
          try {
            const memories = await getMemories(ev.user?.email).catch(() => []);
            const answer = await askGemini(rawText, ev.user?.displayName, memories);
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
              return res.json(w.updateMessage(buildHelpMessage('❌ Could not determine your email address.', [], hasBrain)));
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
              return res.json(w.updateMessage(buildHelpMessage(header, linkButtons, true)));
            } catch (err) {
              console.error('❌ Kitten Brain creation failed:', err.response?.data?.error?.message || err.message);
              return res.json(w.updateMessage(buildHelpMessage(
                '😿 I couldn’t create your Kitten Brain. Please tell Marcus Gallein (IT) — the Drive access for the Kitten may not be set up yet.', [], hasBrain)));
            }
          }

          // ⏰ Reminder settings dialog (stored in the user's Kitten Brain)
          case 'open_reminder_settings': {
            if (!hasBrain) {
              return res.json(w.updateMessage(buildHelpMessage(
                '⏰ Reminder settings live in your Kitten Brain — please click *🧠 Create Kitten Brain* first, then open the settings again.', [], hasBrain)));
            }
            const settings = await getSettings(ev.user?.email);
            return res.json(w.openDialog(buildReminderSettingsCardObject(settings)));
          }

          case 'reminder_settings_submit': {
            const picked = ev.formInputs?.reminder_opts?.stringInputs?.value || [];
            const result = await setSettings(ev.user?.email, {
              reminders_enabled: picked.includes('reminders_enabled'),
              daily_tasks: picked.includes('daily_tasks'),
              task_create: picked.includes('task_create')
            }).catch(err => { console.error('❌ settings save failed:', err.message); return 'error'; });
            if (result === 'no_brain') {
              return res.json(w.closeDialog('⚠️ You need a Kitten Brain first — click 🧠 Create Kitten Brain in the menu.'));
            }
            if (result === 'error') {
              return res.json(w.closeDialog('😿 Could not save your settings. Please try again.'));
            }
            return res.json(w.closeDialog('✅ Reminder settings saved — stored in the SETTINGS tab of your Kitten Brain sheet.'));
          }

          // ❓ Overview of everything the Kitten can do + this user's setup
          case 'show_functions': {
            const settings = await getSettings(ev.user?.email).catch(() => ({ reminders_enabled: true, daily_tasks: false, task_create: true }));
            return res.json(w.openDialog(buildFunctionsCardObject(settings, hasBrain)));
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
              const ticketUrl = `${process.env.JIRA_BASE_URL}/browse/${ticket.key}`;
              console.log(`🎫 Jira ticket created: ${ticket.key} (${projectKey}) by ${reporterEmail}`);
              return res.json(w.newMessage(buildTicketCreatedMessage(ticket.key, ticketUrl)));
            } catch (err) {
              console.error('❌ Jira ticket creation failed:', err.response?.data || err.message);
              return res.json(w.closeDialog('❌ Failed to create the Jira ticket. Please try again or contact IT.'));
            }
          }

          // 📋 My Open Jira Tickets (ported from Jira-MyTickets.js) — paginated
          case 'option_6': {
            const email = ev.user?.email;
            if (!email) {
              return res.json(w.updateMessage(buildHelpMessage('❌ Could not determine your email address.', [], hasBrain)));
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

              return res.json(w.updateMessage(buildHelpMessage(text, extraWidgets, hasBrain)));
            } catch (err) {
              console.error('❌ Fetching tickets failed:', err.response?.data || err.message);
              return res.json(w.updateMessage(buildHelpMessage('❌ Sorry, I couldn’t fetch your Jira tickets. Please try again later.', [], hasBrain)));
            }
          }

          // 🔎 FAQ search: read the query from the card's search field
          case 'faq_search': {
            const query = (ev.formInputs?.faq_query?.stringInputs?.value?.[0] || '').trim();
            if (query.length < 2) {
              return res.json(w.updateMessage(buildHelpMessage('Please type at least 2 characters into the search field. 🔎', [], hasBrain)));
            }
            try {
              const matches = await searchFAQs(query);
              console.log(`🔎 FAQ search "${query}" → ${matches.length} match(es)`);
              return res.json(w.updateMessage(buildFaqResultsMessage(query, matches, hasBrain)));
            } catch (err) {
              console.error('❌ FAQ search failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ search is unavailable right now. Please tell Marcus Gallein.', [], hasBrain)));
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
                return res.json(w.updateMessage(buildFaqResultsMessage(query, matches, hasBrain)));
              }

              const faqs = (await Promise.all(values.map(v => findFAQ(v)))).filter(Boolean);
              if (!faqs.length) return res.json(w.updateMessage(buildHelpMessage(undefined, [], hasBrain)));

              const response = w.updateMessage(buildSelectionMessage(faqs, hasBrain));
              if (process.env.ENABLE_DEBUG_EVENTS === '1') console.log('📤 RESPONSE:', JSON.stringify(response).slice(0, 500));
              return res.json(response);
            } catch (err) {
              console.error('❌ FAQ selection failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ lookup failed. Please tell Marcus Gallein.', [], hasBrain)));
            }
          }

          // 💡 FAQ answer: user clicked one of the search results
          case 'faq_answer': {
            try {
              const faq = await findFAQ(ev.params?.faq_value);
              const responseText = faq?.responseText || 'Hmm. I’m not sure how to help with that yet. 💥';
              return res.json(w.updateMessage(buildAnswerMessage(responseText, hasBrain)));
            } catch (err) {
              console.error('❌ FAQ lookup failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ lookup failed. Please tell Marcus Gallein.', [], hasBrain)));
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
            return res.json(w.updateMessage(buildAnswerMessage(answerTextFor(ev.fn), hasBrain)));
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
