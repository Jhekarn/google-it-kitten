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

// The six menu buttons — same order & ids as in Slack's Menu-Buttons.js
const menuButtons = [
  { text: '🎫 Create a Jira Ticket',        functionName: 'open_jira_modal' },   // option_1
  { text: '❓ HowTo section',                functionName: 'option_2' },
  { text: '⚒️ Request accounts',             functionName: 'option_3' },
  { text: '📄 Submit a New FAQ',             functionName: 'trigger_faq_modal', opensDialog: true }, // option_4
  { text: '📶 What is the wifi password?',   functionName: 'option_5' },
  { text: '📋 My Open Jira Tickets',         functionName: 'option_6' }
];

// The inner card (Cards v2 "card" object).
// extraWidgets are rendered between the header text and the FAQ search —
// used for FAQ search results.
function buildHelpCardObject(headerText = 'Hi there! What do you need help with?', extraWidgets = []) {
  return {
    header: {
      title: 'IT Kitten 🐱',
      subtitle: 'USC internal IT helper'
    },
    sections: [
      {
        widgets: [
          { textParagraph: { text: headerText } },
          ...extraWidgets
        ]
      },
      {
        header: 'Search for help',
        widgets: [
          {
            textInput: {
              label: 'Keyword (e.g. printer, vpn, password)',
              type: 'SINGLE_LINE',
              name: 'faq_query'
            }
          },
          {
            buttonList: {
              buttons: [
                { text: '🔎 Search FAQ', onClick: buttonAction('faq_search') }
              ]
            }
          }
        ]
      },
      {
        widgets: [
          {
            buttonList: {
              buttons: menuButtons.map(b => ({
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
function buildHelpMessage(headerText, extraWidgets = []) {
  return {
    text: 'IT Kitten help menu',
    cardsV2: [
      { cardId: 'kitten_help_menu', card: buildHelpCardObject(headerText, extraWidgets) }
    ]
  };
}

// FAQ search results: matching FAQ titles as buttons (click → answer)
function buildFaqResultsMessage(query, matches) {
  if (!matches.length) {
    return buildHelpMessage(`Hmm. I found nothing for "<b>${query}</b>". 💥 Try another keyword.`);
  }

  const resultButtons = {
    buttonList: {
      buttons: matches.slice(0, 10).map(f => ({
        text: `💡 ${f.suggestion}`,
        onClick: buttonAction('faq_answer', false, [{ key: 'faq_value', value: f.value }])
      }))
    }
  };

  return buildHelpMessage(
    `Results for "<b>${query}</b>" — click one:`,
    [resultButtons]
  );
}

// Foundation placeholder answers. Replaced step by step by the ported features.
const placeholderAnswers = {
  option_2:
    'IT Knowledge base:\nhttps://urbansportsclub.atlassian.net/wiki/spaces/CIA/pages/1534033928/CIA+Help+Center\n' +
    '<i>Tip:</i> Check your Chrome USC folder for more sections.',
  option_3:
    'We <b>do not</b> process access via Jira. Use <b>Okta Access Request</b> in the Okta portal.\n' +
    'Details: https://urbansportsclub.atlassian.net/wiki/spaces/CIA/pages/2660990977/Request+and+approve+Okta+accesses+for+SaaS+apps',
  option_5:
    '🚧 <i>Foundation phase:</i> the WiFi answer will be ported in a later step.',
  open_jira_modal:
    '🚧 <i>Foundation phase:</i> the Jira ticket dialog will be ported in a later step.',
  option_6:
    '🚧 <i>Foundation phase:</i> "My Open Jira Tickets" will be ported in a later step.'
};

function answerTextFor(functionName) {
  return (
    placeholderAnswers[functionName] ||
    'Hmm. I’m not sure how to help with that yet. 💥'
  );
}

// The "Submit FAQ" dialog card (Chat's modal).
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
  buildHelpMessage,
  buildHelpCardObject,
  buildFaqResultsMessage,
  buildFaqDialogCardObject,
  answerTextFor,
  wrappers
};
