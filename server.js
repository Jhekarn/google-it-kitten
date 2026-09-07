// server.js — google-it-kitten foundation
//
// Google Chat version of the IT Kitten Bot. Unlike the Slack version (Socket
// Mode), Google Chat PUSHES events to this public HTTPS endpoint:
//
//   Google Chat  --POST-->  https://<your-render-app>.onrender.com/chat
//
// Every response is simply the JSON we return from that POST (synchronous
// pattern — no client tokens needed for replies). Proactive messages (cron
// reports, reminders) will use the Chat REST API with the GCP service account
// and come in a later step.
//
// Event types handled in the foundation:
//   ADDED_TO_SPACE  → welcome message
//   MESSAGE         → "kitten"/"kitty" keyword or /kitten, /submit-faq commands
//   CARD_CLICKED    → menu buttons + FAQ demo dialog
//   REMOVED_FROM_SPACE → just logged

require('dotenv').config();
const express = require('express');

const { chatAuthMiddleware } = require('./Chat-Auth');
const {
  buildHelpCard,
  buildAnswerResponse,
  buildFaqDialogResponse,
  buildFaqDialogSubmitResponse
} = require('./Menu-Card');

const app = express();
app.use(express.json());

// TEMP: log every incoming request (foundation debugging)
app.use((req, _res, next) => {
  console.log(`📥 ${req.method} ${req.url} | event type: ${req.body?.type || '-'} | auth header: ${req.headers.authorization ? 'yes' : 'no'}`);
  next();
});

// ---- Health check (Render pings this; also nice for browser sanity checks) ----
app.get('/', (_req, res) => {
  res.send('🐱 IT Kitten for Google Chat is running.');
});

// ---- Slash command IDs (must match the numbers configured in the Chat API console) ----
const COMMANDS = {
  KITTEN: 1,      // /kitten     → help menu
  SUBMIT_FAQ: 2   // /submit-faq → FAQ dialog
};

// ---- Main Chat event endpoint ----
app.post('/chat', chatAuthMiddleware(), async (req, res) => {
  const event = req.body || {};

  try {
    switch (event.type) {
      case 'ADDED_TO_SPACE': {
        const spaceType = event.space?.type; // ROOM or DM
        const text =
          spaceType === 'DM'
            ? 'Hi! 🐱 I am IT Kitten. Type *kitten* any time to see what I can help you with.'
            : `Thanks for adding me to *${event.space?.displayName || 'this space'}*! 🐱 Mention me with @IT Kitten or use /kitten to get help.`;
        return res.json({ text });
      }

      case 'MESSAGE':
        return res.json(handleMessage(event));

      case 'CARD_CLICKED':
        return res.json(handleCardClick(event));

      case 'REMOVED_FROM_SPACE':
        console.log(`ℹ️ Removed from space ${event.space?.name}`);
        return res.json({});

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
        return res.json({});
    }
  } catch (err) {
    console.error('🚨 Error handling Chat event:', err);
    return res.json({ text: '❌ Something went wrong. Please tell Marcus Gallein.' });
  }
});

// ---- MESSAGE events: keyword trigger + slash commands ----
function handleMessage(event) {
  const message = event.message || {};

  // Slash command? (configured in the Chat API console with these IDs)
  const commandId =
    message.slashCommand?.commandId ??
    event.appCommandMetadata?.appCommandId ??
    null;

  if (commandId !== null) {
    switch (Number(commandId)) {
      case COMMANDS.KITTEN:
        return buildHelpCard();
      case COMMANDS.SUBMIT_FAQ:
        return buildFaqDialogResponse();
      default:
        return { text: `Unknown command id: ${commandId}` };
    }
  }

  // Keyword trigger — like the Slack regex /^(kitty|kitten)$/i.
  // argumentText = message text WITHOUT the @IT Kitten mention, so this works
  // both in DMs ("kitten") and in spaces ("@IT Kitten kitten" or just @mention).
  const text = (message.argumentText ?? message.text ?? '').trim().toLowerCase();

  if (text === '' || text === 'kitty' || text === 'kitten' || text === 'help') {
    return buildHelpCard();
  }

  return {
    text: 'Meow! 🐱 Type *kitten* (or use /kitten) and I’ll show you what I can do.'
  };
}

// ---- CARD_CLICKED events: menu buttons and dialog submits ----
function handleCardClick(event) {
  const fn = event.common?.invokedFunction;

  switch (fn) {
    case 'trigger_faq_modal':
      return buildFaqDialogResponse();

    case 'faq_dialog_submit':
      return buildFaqDialogSubmitResponse(event.common?.formInputs);

    // All other menu buttons → update the message with (placeholder) answer + menu
    case 'open_jira_modal':
    case 'option_2':
    case 'option_3':
    case 'option_5':
    case 'option_6':
      return buildAnswerResponse(fn);

    default:
      console.log(`ℹ️ Unhandled card function: ${fn}`);
      return buildAnswerResponse('unknown');
  }
}

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡️ google-it-kitten foundation is listening on port ${PORT}`);
});

module.exports = app; // exported for tests
