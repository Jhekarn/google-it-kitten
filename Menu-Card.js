// Menu-Card.js — the Kitten help menu as a Google Chat "Cards v2" card.
// Google Chat equivalent of Menu-Buttons.js + getHelpMenu() from the Slack
// version. Same action ids (open_jira_modal, option_2, ...) so feature porting
// maps 1:1 to the old code.
//
// This app runs in Google's NEW add-on event format, so responses are wrapped:
//   new message   → hostAppDataAction.chatDataAction.createMessageAction
//   update msg    → hostAppDataAction.chatDataAction.updateMessageAction
//   open dialog   → action.navigations[].pushCard
//   close dialog  → action.navigations[].endNavigation + notification
// (The old classic wrappers are also provided for the local test script.)

// In the add-on format, onClick.action.function must be the ENDPOINT URL of
// this app — the logical action name travels in action.parameters.actionName.
// We reuse CHAT_APP_AUDIENCE (the /chat URL) as that endpoint.
const ACTION_ENDPOINT = process.env.CHAT_APP_AUDIENCE || 'action';

function buttonAction(actionName, opensDialog = false, extraParams = []) {
  const action = {
    function: ACTION_ENDPOINT,
    parameters: [{ key: 'actionName', value: actionName }, ...extraParams]
  };
  // Buttons that open a dialog MUST declare it, or Chat rejects the response
  if (opensDialog) action.interaction = 'OPEN_DIALOG';
  return { action };
}

// Make URLs in answer texts clickable in Chat cards:
//  - Slack-style links <https://url|Label>  → <a href="url">Label</a>
//  - bare URLs                              → <a href="url">url</a>
// Existing <a href> markup is left untouched.
function toChatHtml(text) {
  if (!text) return text;
  let out = text.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, '<a href="$1">$2</a>');
  out = out.replace(
    /(^|[^"'>=\w])(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?])/g,
    '$1<a href="$2">$2</a>'
  );
  return out;
}

// Extract all URLs from an answer text (after link normalization)
function extractUrls(text) {
  const html = toChatHtml(text || '');
  const re = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?]/g;
  return [...new Set(html.match(re) || [])];
}

// An answer message: text + "Open link" button(s) that open in a new tab
function buildAnswerMessage(text, hasBrain = false) {
  const urls = extractUrls(text).slice(0, 3);
  const widgets = urls.length
    ? [{
        buttonList: {
          buttons: urls.map((u, i) => ({
            text: urls.length > 1 ? `🔗 Open link ${i + 1}` : '🔗 Open link',
            onClick: { openLink: { url: u } }
          }))
        }
      }]
    : [];
  return buildHelpMessage(text, widgets, hasBrain);
}

// The menu buttons — same order & ids as in Slack's Menu-Buttons.js.
// The Kitten Brain button label depends on whether THIS user already has one.
function menuButtons(hasBrain = false) {
  return [
    { text: '🎫 Create a Jira Ticket',        functionName: 'open_jira_modal', opensDialog: true }, // option_1
    { text: '❓ HowTo section',                functionName: 'option_2' },
    { text: '⚒️ Request accounts',             functionName: 'option_3' },
    { text: '📄 Submit a New FAQ',             functionName: 'trigger_faq_modal', opensDialog: true }, // option_4
    { text: '📶 What is the wifi password?',   functionName: 'option_5' },
    { text: '📋 My Open Jira Tickets',         functionName: 'option_6' },
    { text: hasBrain ? '🧠 Gogo Kitten Brain' : '🧠 Create Kitten Brain', functionName: 'create_brain' }, // per-user private memory
    { text: '⏰ Reminder settings',            functionName: 'open_reminder_settings', opensDialog: true },
    { text: '❓ What can I do?',               functionName: 'show_functions', opensDialog: true }
  ];
}

// The inner card (Cards v2 "card" object).
// extraWidgets are rendered between the header text and the FAQ search —
// used for FAQ search results.
function buildHelpCardObject(headerText = 'Hi there! What do you need help with?', extraWidgets = [], hasBrain = false) {
  return {
    header: {
      title: 'IT Kitten 🐱',
      subtitle: 'USC internal IT helper'
    },
    sections: [
      {
        widgets: [
          { textParagraph: { text: toChatHtml(headerText) } },
          ...extraWidgets
        ]
      },
      {
        header: 'Search for help',
        widgets: [
          {
            // Live autocomplete (Slack external_select equivalent):
            // typing triggers faq_autocomplete, picking triggers faq_selected
            selectionInput: {
              name: 'faq_select',
              type: 'MULTI_SELECT',
              label: '🔎 Start typing to search the FAQ...',
              multiSelectMaxSelectedItems: 3,
              multiSelectMinQueryLength: 2,
              externalDataSource: buttonAction('faq_autocomplete').action,
              onChangeAction: buttonAction('faq_selected').action
            }
          }
        ]
      },
      {
        widgets: [
          {
            buttonList: {
              buttons: menuButtons(hasBrain).map(b => ({
                text: b.text,
                onClick: buttonAction(b.functionName, b.opensDialog)
              }))
            }
          }
        ]
      }
    ]
  };
}

// A complete Chat "message" object with the help card
function buildHelpMessage(headerText, extraWidgets = [], hasBrain = false) {
  return {
    text: 'IT Kitten help menu',
    cardsV2: [
      { cardId: 'kitten_help_menu', card: buildHelpCardObject(headerText, extraWidgets, hasBrain) }
    ]
  };
}

// True when an FAQ answer is essentially just a link (no real text around it)
function isLinkOnlyAnswer(responseText) {
  const urls = extractUrls(responseText);
  if (urls.length !== 1) return false;
  const stripped = (responseText || '')
    .replace(/<[^>]*>/g, ' ')                 // markup incl. Slack-style links
    .replace(/https?:\/\/[^\s<>"']+/g, ' ')   // the URL itself
    .replace(/[\s:,.\-–—>]+/g, ' ')
    .trim();
  return stripped.length < 10;
}

// FAQ search results: matching FAQ titles as buttons.
// Link-only answers open the page DIRECTLY (new tab); text answers show
// the answer card (which itself carries an Open-link button when needed).
function buildFaqResultsMessage(query, matches, hasBrain = false) {
  if (!matches.length) {
    return buildHelpMessage(`Hmm. I found nothing for "<b>${query}</b>". 💥 Try another keyword.`, [], hasBrain);
  }

  const resultButtons = {
    buttonList: {
      buttons: matches.slice(0, 10).map(f => {
        if (isLinkOnlyAnswer(f.responseText)) {
          return {
            text: `🔗 ${f.suggestion}`,
            onClick: { openLink: { url: extractUrls(f.responseText)[0] } }
          };
        }
        return {
          text: `💡 ${f.suggestion}`,
          onClick: buttonAction('faq_answer', false, [{ key: 'faq_value', value: f.value }])
        };
      })
    }
  };

  return buildHelpMessage(
    `Results for "<b>${query}</b>" — click one:`,
    [resultButtons],
    hasBrain
  );
}

// Message after the user picked FAQ(s) from the autocomplete dropdown:
// a single text answer is shown directly; link-only or multiple picks
// become buttons (link-only ones open the page directly, new tab).
function buildSelectionMessage(faqs, hasBrain = false) {
  if (!faqs.length) {
    return buildHelpMessage('Hmm. I couldn’t find that FAQ anymore. 💥 Try the search again.', [], hasBrain);
  }
  if (faqs.length === 1 && !isLinkOnlyAnswer(faqs[0].responseText)) {
    const txt = (faqs[0].responseText || '').trim();
    if (!txt) {
      return buildHelpMessage(`ℹ️ "<b>${faqs[0].suggestion}</b>" has no help text stored in the FAQ DB yet. Please tell Marcus Gallein.`, [], hasBrain);
    }
    return buildAnswerMessage(txt, hasBrain);
  }
  return buildFaqResultsMessage('your selection', faqs, hasBrain);
}

// Menu answers, ported from Slack's Menu-Buttons.js.
// WiFi passwords come from env (repo is public!): WIFI_PW_BERLIN,
// WIFI_PW_VALENCIA, WIFI_PW_GUEST — set them on Render.
const menuAnswers = {
  option_2:
    'IT Knowledge base:\nhttps://urbansportsclub.atlassian.net/wiki/spaces/CIA/pages/1534033928/CIA+Help+Center\n' +
    '<i>Tip:</i> Check your Chrome USC folder for more sections.',
  option_3:
    'We <b>do not</b> process access via Jira. Use <b>Okta Access Request</b> in the Okta portal.\n' +
    'Details: https://urbansportsclub.atlassian.net/wiki/spaces/CIA/pages/2660990977/Request+and+approve+Okta+accesses+for+SaaS+apps',
  option_5: () =>
    `The Password for the office in <b>Berlin</b> is <b>${process.env.WIFI_PW_BERLIN || '(not configured)'}</b> ` +
    `while the one for <b>Valencia</b> is <b>${process.env.WIFI_PW_VALENCIA || '(not configured)'}</b>.\n\n` +
    `<b>However,</b> if you have guests please let them sign in to the <b>guest network</b> using ` +
    `<b>${process.env.WIFI_PW_GUEST || '(not configured)'}</b> as the password.\n` +
    `Please <b>do not</b> share the internal password with guests.`
};

function answerTextFor(functionName) {
  const answer = menuAnswers[functionName];
  if (typeof answer === 'function') return answer();
  return answer || 'Hmm. I’m not sure how to help with that yet. 💥';
}

// The "New Jira Ticket" dialog card — ported from Slack's open_jira_modal.
// Projects: IT Helpdesk (IH), SRE (SRE), DevX (DX), Security (SECHELP).
function buildJiraDialogCardObject() {
  return {
    sections: [
      {
        header: 'New Jira Ticket',
        widgets: [
          {
            selectionInput: {
              name: 'jira_project',
              type: 'DROPDOWN',
              label: 'Which project is this for?',
              items: [
                { text: 'IT Helpdesk - #it-support', value: 'IH', selected: true },
                { text: 'SRE Team - #hive-platform-ask', value: 'SRE' },
                { text: 'DevX Team - #hive-platform-ask', value: 'DX' },
                { text: 'Security Team - #security-ask', value: 'SECHELP' }
              ]
            }
          },
          {
            textInput: {
              label: 'Ticket Title',
              type: 'SINGLE_LINE',
              name: 'jira_title'
            }
          },
          {
            textInput: {
              label: 'Ticket Description',
              type: 'MULTIPLE_LINE',
              name: 'jira_desc'
            }
          },
          {
            buttonList: {
              buttons: [
                {
                  text: 'Create',
                  onClick: buttonAction('jira_dialog_submit')
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

// Confirmation message after a ticket was created (posted into the chat,
// which also closes the dialog) — with a direct link to the ticket.
function buildTicketCreatedMessage(ticketKey, ticketUrl) {
  return {
    text: `✅ Jira ticket ${ticketKey} created`,
    cardsV2: [
      {
        cardId: 'jira_ticket_created',
        card: {
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      `✅ Your Jira ticket <b>${ticketKey}</b> has been created.\n` +
                      `If you have any attachments, please add them directly to the ticket now.`
                  }
                },
                {
                  buttonList: {
                    buttons: [
                      { text: `🔗 View ${ticketKey} in Jira`, onClick: { openLink: { url: ticketUrl } } }
                    ]
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  };
}

// The "Submit FAQ" dialog card (Chat's modal). Submit only echoes for now —
// the Google Sheet write is ported in step 2.
function buildFaqDialogCardObject() {
  return {
    sections: [
      {
        header: 'Submit FAQ',
        widgets: [
          {
            textInput: {
              label: 'FAQ Title',
              type: 'SINGLE_LINE',
              name: 'faq_title'
            }
          },
          {
            textInput: {
              label: 'Help Text for Users',
              type: 'MULTIPLE_LINE',
              name: 'faq_helptext'
            }
          },
          {
            buttonList: {
              buttons: [
                {
                  text: 'Submit',
                  onClick: buttonAction('faq_dialog_submit')
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

// ---------- ⏰ Reminder settings dialog ----------
// Toggles are stored in the SETTINGS tab of the user's own Kitten Brain sheet.
function buildReminderSettingsCardObject(settings) {
  return {
    sections: [
      {
        header: '⏰ Reminder settings',
        widgets: [
          {
            textParagraph: {
              text: 'Stored in the <b>SETTINGS</b> tab of your own Kitten Brain sheet — your memories are untouched.'
            }
          },
          {
            selectionInput: {
              name: 'reminder_opts',
              type: 'SWITCH',
              label: 'What may the Kitten do for you?',
              items: [
                { text: '🔔 Send me reminders (master switch)', value: 'reminders_enabled', selected: !!settings.reminders_enabled },
                { text: '⏰ Remind me of my tasks due today (DM at 08:00 Berlin)', value: 'daily_tasks', selected: !!settings.daily_tasks },
                { text: '📝 Allow "create me a task ..." via chat', value: 'task_create', selected: !!settings.task_create }
              ]
            }
          },
          {
            buttonList: {
              buttons: [{ text: 'Save', onClick: buttonAction('reminder_settings_submit') }]
            }
          }
        ]
      }
    ]
  };
}

// ---------- ❓ "What can I do?" overview dialog ----------
function buildFunctionsCardObject(settings, hasBrain) {
  const on = v => (v ? '✅ ON' : '❌ OFF');
  return {
    sections: [
      {
        header: '🐱 What IT Kitten can do',
        widgets: [
          {
            textParagraph: {
              text:
                '📚 <b>FAQ search</b> — type in the menu\'s search field (live suggestions)\n' +
                '🎫 <b>Create a Jira ticket</b> — menu button (IT, SRE, DevX, Security)\n' +
                '📋 <b>My open Jira tickets</b> — menu button (paginated list)\n' +
                '📄 <b>Submit a new FAQ</b> — menu button\n' +
                '📶 <b>WiFi, HowTos, account access</b> — menu buttons\n' +
                '🤖 <b>Ask anything</b> — just type a free-text question (AI, any language)\n' +
                '📝 <b>Create a Google Task</b> — write "create me a task for ..."'
            }
          }
        ]
      },
      {
        header: '🧠 Kitten Brain (your private memory)',
        widgets: [
          {
            textParagraph: {
              text:
                `Status: ${hasBrain ? '✅ created' : '❌ not created yet — menu → Create Kitten Brain'}\n` +
                '• <b>remember ...</b> — I store it, visible only to you\n' +
                '• <b>forget ...</b> — I show you where to delete it'
            }
          }
        ]
      },
      {
        header: '⏰ Reminders & tasks — your current setup',
        widgets: [
          {
            textParagraph: {
              text:
                `🔔 Reminders (master switch): ${on(settings.reminders_enabled)}\n` +
                `⏰ Daily "tasks due today" DM (08:00 Berlin): ${on(settings.daily_tasks)}\n` +
                `📝 "create me a task ..." via chat: ${on(settings.task_create)}\n\n` +
                `Change these: menu → ⏰ Reminder settings${hasBrain ? '' : ' (needs a Kitten Brain first)'}`
            }
          }
        ]
      }
    ]
  };
}

// ---------- 📝 Google Task creation ----------
// Dialog: editable task text (prefilled from the chat message) + optional date.
function buildTaskDialogCardObject(prefill = '') {
  return {
    sections: [
      {
        header: '📝 New Google Task',
        widgets: [
          {
            textInput: {
              label: 'Task',
              type: 'SINGLE_LINE',
              name: 'task_title',
              value: prefill
            }
          },
          {
            dateTimePicker: {
              label: 'Target date (optional)',
              name: 'task_due',
              type: 'DATE_ONLY'
            }
          },
          { textParagraph: { text: 'No date picked = the task is created without a due date.' } },
          {
            buttonList: {
              buttons: [{ text: 'Create', onClick: buttonAction('task_dialog_submit') }]
            }
          }
        ]
      }
    ]
  };
}

// Chat reply that offers to open the task dialog (dialogs can only be opened
// from a button click — Chat platform rule — so this button is the bridge).
function buildTaskOfferMessage(taskText) {
  const short = (taskText || '').slice(0, 180);
  return {
    text: '📝 New task',
    cardsV2: [
      {
        cardId: 'task_offer',
        card: {
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      `📝 I can create this Google Task for you:\n<b>${short || '(you\'ll type it in the next step)'}</b>\n\n` +
                      'Click below to review it, optionally pick a target date, and create it — it lands in YOUR Google Tasks.'
                  }
                },
                {
                  buttonList: {
                    buttons: [
                      { text: '📝 Create this task…', onClick: buttonAction('open_task_modal', true, [{ key: 'prefill', value: short }]) }
                    ]
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  };
}

// ---------- Response wrappers: NEW add-on format ----------

const addon = {
  newMessage: message => ({
    hostAppDataAction: { chatDataAction: { createMessageAction: { message } } }
  }),
  updateMessage: message => ({
    hostAppDataAction: { chatDataAction: { updateMessageAction: { message } } }
  }),
  openDialog: cardObject => ({
    action: { navigations: [{ pushCard: cardObject }] }
  }),
  closeDialog: notificationText => ({
    action: {
      navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }],
      notification: { text: notificationText }
    }
  })
};

// ---------- Response wrappers: classic format (local test script) ----------

const classic = {
  newMessage: message => message,
  updateMessage: message => ({ actionResponse: { type: 'UPDATE_MESSAGE' }, ...message }),
  openDialog: cardObject => ({
    actionResponse: { type: 'DIALOG', dialogAction: { dialog: { body: cardObject } } }
  }),
  closeDialog: notificationText => ({
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'OK', userFacingMessage: notificationText } }
    }
  })
};

function wrappers(isAddon) {
  return isAddon ? addon : classic;
}

module.exports = {
  buttonAction,
  buildHelpMessage,
  buildHelpCardObject,
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
};
