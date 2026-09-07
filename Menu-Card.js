// Menu-Card.js — the Kitten help menu as a Google Chat "Cards v2" card.
// This is the Google Chat equivalent of Menu-Buttons.js + getHelpMenu() from the
// Slack version. Same action ids are kept (open_jira_modal, option_2, ...) so the
// feature porting in the next steps maps 1:1 to the old code.
//
// NOTE (foundation phase): all buttons work and answer, but with placeholder
// texts where the real feature (Jira, Sheets, ...) is not ported yet.

// The six menu buttons — same order & ids as in Slack's Menu-Buttons.js
const menuButtons = [
  { text: '🎫 Create a Jira Ticket',        functionName: 'open_jira_modal' },   // option_1
  { text: '❓ HowTo section',                functionName: 'option_2' },
  { text: '⚒️ Request accounts',             functionName: 'option_3' },
  { text: '📄 Submit a New FAQ',             functionName: 'trigger_faq_modal' }, // option_4
  { text: '📶 What is the wifi password?',   functionName: 'option_5' },
  { text: '📋 My Open Jira Tickets',         functionName: 'option_6' }
];

// Build the help-menu card. `headerText` lets us swap the intro line when we
// update the card with an answer (same pattern as respondInChat in Slack).
function buildHelpCard(headerText = 'Hi there! What do you need help with?') {
  return {
    cardsV2: [
      {
        cardId: 'kitten_help_menu',
        card: {
          header: {
            title: 'IT Kitten 🐱',
            subtitle: 'USC internal IT helper'
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: headerText } },
                {
                  buttonList: {
                    buttons: menuButtons.map(b => ({
                      text: b.text,
                      onClick: {
                        action: {
                          function: b.functionName
                        }
                      }
                    }))
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

// Foundation placeholder answers. In the coming steps these get replaced by the
// real ported logic (Jira modal → Chat dialog, Sheets lookup, etc.).
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

// Build an "update the existing message" response (Slack chat.update equivalent):
// the card is re-rendered with the answer text on top and the menu below it.
function buildAnswerResponse(functionName) {
  const answer =
    placeholderAnswers[functionName] ||
    'Hmm. I’m not sure how to help with that yet. 💥';

  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    ...buildHelpCard(answer)
  };
}

// The "Submit FAQ" dialog — Google Chat's equivalent of the Slack modal.
// Included already in the foundation to prove that dialogs work end-to-end.
// On submit it only echoes the values back (no Google Sheet write yet).
function buildFaqDialogResponse() {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
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
                          onClick: {
                            action: {
                              function: 'faq_dialog_submit'
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        }
      }
    }
  };
}

// Close the dialog with a confirmation (foundation: echo only, no Sheet write yet).
function buildFaqDialogSubmitResponse(formInputs) {
  const title = formInputs?.faq_title?.stringInputs?.value?.[0] || '(empty)';
  const helptext = formInputs?.faq_helptext?.stringInputs?.value?.[0] || '(empty)';

  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        actionStatus: {
          statusCode: 'OK',
          userFacingMessage:
            `✅ Dialog works! Received: "${title}" — Google Sheet saving comes in a later step. (${helptext.length} chars help text)`
        }
      }
    }
  };
}

module.exports = {
  buildHelpCard,
  buildAnswerResponse,
  buildFaqDialogResponse,
  buildFaqDialogSubmitResponse
};
