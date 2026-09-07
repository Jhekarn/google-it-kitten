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

const { chatAuthMiddleware } = require('./Chat-Auth');
const {
  buildHelpMessage,
  buildFaqDialogCardObject,
  answerTextFor,
  wrappers
} = require('./Menu-Card');

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

// ---- Slash command IDs (must match the Chat API console config) ----
const COMMANDS = {
  KITTEN: 1,      // /kitten     → help menu
  SUBMIT_FAQ: 2   // /submit-faq → FAQ dialog
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
      // Action name travels in commonEventObject.parameters.actionName
      // (parameters can be a map {actionName: 'x'} or an array [{key,value}])
      let actionName = common.invokedFunction;
      const p = common.parameters;
      if (!actionName && p) {
        actionName = Array.isArray(p)
          ? p.find(e => e.key === 'actionName')?.value
          : p.actionName;
      }
      return {
        isAddon: true,
        kind: 'click',
        fn: actionName,
        formInputs: common.formInputs,
        isDialogEvent: !!c.buttonClickedPayload.isDialogEvent,
        user: c.user
      };
    }
    if (c.addedToSpacePayload) {
      return { isAddon: true, kind: 'added', space: c.addedToSpacePayload.space, user: c.user };
    }
    if (c.removedFromSpacePayload) {
      return { isAddon: true, kind: 'removed' };
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
          case COMMANDS.SUBMIT_FAQ:
            return res.json(w.openDialog(buildFaqDialogCardObject()));
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

      case 'click': {
        switch (ev.fn) {
          case 'trigger_faq_modal':
            return res.json(w.openDialog(buildFaqDialogCardObject()));

          case 'faq_dialog_submit': {
            const title = ev.formInputs?.faq_title?.stringInputs?.value?.[0] || '(empty)';
            const helptext = ev.formInputs?.faq_helptext?.stringInputs?.value?.[0] || '';
            return res.json(w.closeDialog(
              `✅ Dialog works! Received: "${title}" — Google Sheet saving comes in a later step. (${helptext.length} chars help text)`
            ));
          }

          // All other menu buttons → update the message with (placeholder) answer + menu
          default:
            return res.json(w.updateMessage(buildHelpMessage(answerTextFor(ev.fn))));
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
