// server.js — google-it-kitten
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

// ---- Scheduled jobs (like the Slack server.js) ----
// Every Monday 08:00 UTC (= 09:00/10:00 Berlin): weekly satisfaction report
cron.schedule('0 8 * * 1', async () => {
  console.log('⏰ Running weekly satisfaction report...');
  try {
    await runWeeklyReport();
  } catch (err) {
    console.error('🚨 Weekly report failed:', err.message);
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
  }
});

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
    return res.status(404).send('Unknown job. Use /jobs/weekly or /jobs/reminder.');
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
        params: {},
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
            return res.json(w.newMessage(buildHelpMessage()));
          default:
            return res.json(w.newMessage({ text: `Unknown command id: ${ev.commandId}` }));
        }
      }

      case 'message': {
        // Keyword trigger — like the Slack regex /^(kitty|kitten)$/i.
        // argumentText = text without the @mention, so it works in DMs and spaces.
        const text = (ev.message?.argumentText ?? ev.message?.text ?? '').trim().toLowerCase();
        if (text === '' || text === 'kitty' || text === 'kitten' || text === 'help') {
          return res.json(w.newMessage(buildHelpMessage()));
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
              return res.json(w.updateMessage(buildHelpMessage('❌ Could not determine your email address.')));
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

              return res.json(w.updateMessage(buildHelpMessage(text, extraWidgets)));
            } catch (err) {
              console.error('❌ Fetching tickets failed:', err.response?.data || err.message);
              return res.json(w.updateMessage(buildHelpMessage('❌ Sorry, I couldn’t fetch your Jira tickets. Please try again later.')));
            }
          }

          // 🔎 FAQ search: read the query from the card's search field
          case 'faq_search': {
            const query = (ev.formInputs?.faq_query?.stringInputs?.value?.[0] || '').trim();
            if (query.length < 2) {
              return res.json(w.updateMessage(buildHelpMessage('Please type at least 2 characters into the search field. 🔎')));
            }
            try {
              const matches = await searchFAQs(query);
              console.log(`🔎 FAQ search "${query}" → ${matches.length} match(es)`);
              return res.json(w.updateMessage(buildFaqResultsMessage(query, matches)));
            } catch (err) {
              console.error('❌ FAQ search failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ search is unavailable right now. Please tell Marcus Gallein.')));
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
                return res.json(w.updateMessage(buildFaqResultsMessage(query, matches)));
              }

              const faqs = (await Promise.all(values.map(v => findFAQ(v)))).filter(Boolean);
              if (!faqs.length) return res.json(w.updateMessage(buildHelpMessage()));

              const response = w.updateMessage(buildSelectionMessage(faqs));
              if (process.env.ENABLE_DEBUG_EVENTS === '1') console.log('📤 RESPONSE:', JSON.stringify(response).slice(0, 500));
              return res.json(response);
            } catch (err) {
              console.error('❌ FAQ selection failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ lookup failed. Please tell Marcus Gallein.')));
            }
          }

          // 💡 FAQ answer: user clicked one of the search results
          case 'faq_answer': {
            try {
              const faq = await findFAQ(ev.params?.faq_value);
              const responseText = faq?.responseText || 'Hmm. I’m not sure how to help with that yet. 💥';
              return res.json(w.updateMessage(buildAnswerMessage(responseText)));
            } catch (err) {
              console.error('❌ FAQ lookup failed:', err.message);
              return res.json(w.updateMessage(buildHelpMessage('⚠️ FAQ lookup failed. Please tell Marcus Gallein.')));
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

          // All other menu buttons → update the message with answer + menu
          default:
            return res.json(w.updateMessage(buildAnswerMessage(answerTextFor(ev.fn))));
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
