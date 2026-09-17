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

// ---- Version & bug reporting (shown small at the bottom of the menu) ----
// Bump KITTEN_VERSION with every deploy that changes behavior.
const KITTEN_VERSION = '2.6.2';
// Chat cards cannot open the OS mail app, so "Report a Bug" opens a
// PREFILLED Gmail compose window instead (same result, works for everyone
// in the Workspace domain).
const BUG_REPORT_URL =
  'https://mail.google.com/mail/?view=cm&fs=1' +
  '&to=' + encodeURIComponent('it-support@urbansportsclub.com') +
  '&su=' + encodeURIComponent('Bugreport for IT Kitten (Google Chat Version)') +
  '&body=' + encodeURIComponent(`Kitten version: v${KITTEN_VERSION}\n\nWhat happened:\n\nWhat did you expect:\n`);

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
function buildAnswerMessage(text, hasBrain = false, isAdmin = false) {
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
  return buildHelpMessage(text, widgets, hasBrain, isAdmin);
}

// The menu buttons — same order & ids as in Slack's Menu-Buttons.js.
// The Kitten Brain button label depends on whether THIS user already has one;
// the 🛠️ Admin button only appears for emails in the "Admin access" tab.
function menuButtons(hasBrain = false, isAdmin = false) {
  const buttons = [
    { text: '🎫 Create a Jira Ticket',        functionName: 'open_jira_modal', opensDialog: true }, // option_1
    { text: '❓ HowTo section',                functionName: 'option_2' },
    { text: '⚒️ Request accounts',             functionName: 'option_3' },
    { text: '📄 Submit a New FAQ',             functionName: 'trigger_faq_modal', opensDialog: true }, // option_4
    { text: '📶 What is the wifi password?',   functionName: 'option_5' },
    { text: '📋 My Open Jira Tickets',         functionName: 'option_6' },
    { text: hasBrain ? '🧠 Gogo Kitten Brain' : '🧠 Create Kitten Brain', functionName: 'create_brain' }, // per-user private memory
    { text: '⏰ Reminder settings',            functionName: 'open_reminder_settings', opensDialog: true },
    { text: '⏱️ My reminders',                 functionName: 'open_my_reminders', opensDialog: true },
    { text: '❓ What can I do?',               functionName: 'show_functions', opensDialog: true }
  ];
  if (isAdmin) buttons.push({ text: '🛠️ Admin', functionName: 'open_admin', opensDialog: true });
  return buttons;
}

// The inner card (Cards v2 "card" object).
// extraWidgets are rendered between the header text and the FAQ search —
// used for FAQ search results.
function buildHelpCardObject(headerText = 'Hi there! What do you need help with?', extraWidgets = [], hasBrain = false, isAdmin = false) {
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
              buttons: menuButtons(hasBrain, isAdmin).map(b => ({
                text: b.text,
                onClick: buttonAction(b.functionName, b.opensDialog)
              }))
            }
          }
        ]
      },
      {
        // small, muted footer: version + bug report link
        widgets: [
          {
            textParagraph: {
              text:
                `<font color="#80868B">IT Kitten v${KITTEN_VERSION}\n` +
                `<a href="${BUG_REPORT_URL}">🐞 Report a Bug</a></font>`
            }
          }
        ]
      }
    ]
  };
}

// A complete Chat "message" object with the help card
function buildHelpMessage(headerText, extraWidgets = [], hasBrain = false, isAdmin = false) {
  return {
    text: 'IT Kitten help menu',
    cardsV2: [
      { cardId: 'kitten_help_menu', card: buildHelpCardObject(headerText, extraWidgets, hasBrain, isAdmin) }
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
function buildFaqResultsMessage(query, matches, hasBrain = false, isAdmin = false) {
  if (!matches.length) {
    return buildHelpMessage(`Hmm. I found nothing for "<b>${query}</b>". 💥 Try another keyword.`, [], hasBrain, isAdmin);
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
    hasBrain,
    isAdmin
  );
}

// Message after the user picked FAQ(s) from the autocomplete dropdown:
// a single text answer is shown directly; link-only or multiple picks
// become buttons (link-only ones open the page directly, new tab).
function buildSelectionMessage(faqs, hasBrain = false, isAdmin = false) {
  if (!faqs.length) {
    return buildHelpMessage('Hmm. I couldn’t find that FAQ anymore. 💥 Try the search again.', [], hasBrain, isAdmin);
  }
  if (faqs.length === 1 && !isLinkOnlyAnswer(faqs[0].responseText)) {
    const txt = (faqs[0].responseText || '').trim();
    if (!txt) {
      return buildHelpMessage(`ℹ️ "<b>${faqs[0].suggestion}</b>" has no help text stored in the FAQ DB yet. Please tell Marcus Gallein.`, [], hasBrain, isAdmin);
    }
    return buildAnswerMessage(txt, hasBrain, isAdmin);
  }
  return buildFaqResultsMessage('your selection', faqs, hasBrain, isAdmin);
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
                { text: '⏰ Remind me of my tasks due today (daily DM)', value: 'daily_tasks', selected: !!settings.daily_tasks },
                { text: '🌅 Morning day-brief (today\'s meetings, daily DM)', value: 'morning_brief', selected: !!settings.morning_brief },
                { text: '📝 Allow "create me a task ..." via chat', value: 'task_create', selected: !!settings.task_create }
              ]
            }
          },
          {
            selectionInput: {
              name: 'digest_hour',
              type: 'DROPDOWN',
              label: '🕗 Daily reminder time (Berlin) — tasks & day-brief',
              items: Array.from({ length: 15 }, (_, i) => {
                const h = i + 6; // 06:00 … 20:00
                return { text: `${String(h).padStart(2, '0')}:00`, value: String(h), selected: Number(settings.digest_hour) === h };
              })
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

// ---------- ❓ "What can I do?" overview dialog (tabbed) ----------
// Chat dialogs have no native side-nav tabs, so a button row at the top
// switches the card content (via updateCard navigation → show_functions_tab).
const FUNCTION_TABS = [
  { id: 'standard',  label: '⚙️ Standard functions' },
  { id: 'brain',     label: '🧠 Kitten Brain' },
  { id: 'reminders', label: '⏰ Reminders' },
  { id: 'commands',  label: '⌨️ Chat commands' }
];

function functionsTabContent(tab, settings, hasBrain) {
  const on = v => (v ? '✅ ON' : '❌ OFF');
  const hour = String(settings.digest_hour ?? 8).padStart(2, '0');

  if (tab === 'brain') {
    return {
      header: '🧠 Kitten Brain — your private memory',
      widgets: [{
        textParagraph: {
          text:
            `Status: ${hasBrain ? '✅ created' : '❌ not created yet — menu → 🧠 Create Kitten Brain'}\n\n` +
            '• <b>remember ...</b> — I store it in YOUR own Google Drive, visible only to you\n' +
            '• <b>forget ...</b> — I show you where to delete it (you stay in control)\n' +
            '• Your memories are only ever used in YOUR conversations with me\n' +
            '• The folder "Kitten Brain" in your Drive must not be deleted\n' +
            '• Your ⏰ Reminder settings are stored there too (SETTINGS tab)'
        }
      }]
    };
  }

  if (tab === 'reminders') {
    return {
      header: '⏰ Reminders — features & your current setup',
      widgets: [{
        textParagraph: {
          text:
            '<b>What I can do:</b>\n' +
            '⏰ Daily "tasks due today" DM — your open Google Tasks every morning\n' +
            '🌅 Morning day-brief — today\'s meetings (+ tasks) in one morning DM\n' +
            '⏱️ One-off reminders — "remind me in 2 hours to ..." (see Chat commands)\n' +
            '📝 Create Google Tasks by chat — I never delete or complete tasks\n\n' +
            '<b>Your current setup:</b>\n' +
            `🔔 Reminders (master switch): ${on(settings.reminders_enabled)}\n` +
            `⏰ Daily tasks DM (${hour}:00 Berlin): ${on(settings.daily_tasks)}\n` +
            `🌅 Morning day-brief (${hour}:00 Berlin): ${on(settings.morning_brief)}\n` +
            `📝 "create me a task ..." via chat: ${on(settings.task_create)}\n\n` +
            `Change these: menu → ⏰ Reminder settings${hasBrain ? '' : ' (needs a Kitten Brain first)'}`
        }
      }]
    };
  }

  if (tab === 'commands') {
    return {
      header: '⌨️ Chat commands — just type these to me',
      widgets: [{
        textParagraph: {
          text:
            '<b>kitten</b> / <b>kitty</b> / <b>help</b> — open the menu\n\n' +
            '<b>create me a task for</b> ordering a new cable — new Google Task (popup with optional date)\n\n' +
            '<b>remember</b> I use a MacBook Pro — store a private memory (needs a Kitten Brain)\n' +
            '<b>forget</b> ... — I show you where to delete a memory\n\n' +
            '<b>remind me in 2 hours to</b> check the deploy — one-off reminder ' +
            '(times like "at 15:30", "tomorrow at 9", "on friday" or "on 24.12. at 10" work too)\n' +
            '<b>my reminders</b> — list your open reminders, each with a number\n' +
            '<b>cancel reminder</b> + the number from that list (e.g. <b>cancel reminder 1</b>) — cancel it. ' +
            'Or use the ⏱️ <b>My reminders</b> menu button and cancel with one click.\n\n' +
            '🤖 <b>Anything else</b> — free-text questions go to my AI brain (any language)'
        }
      }]
    };
  }

  // default: standard functions (all menu buttons)
  return {
    header: '⚙️ Standard functions — the menu buttons',
    widgets: [{
      textParagraph: {
        text:
          '🎫 <b>Create a Jira Ticket</b> — IT Helpdesk, SRE, DevX or Security\n' +
          '❓ <b>HowTo section</b> — link to the IT knowledge base\n' +
          '⚒️ <b>Request accounts</b> — how to request access via Okta\n' +
          '📄 <b>Submit a New FAQ</b> — add knowledge to the FAQ database\n' +
          '📶 <b>WiFi password</b> — office & guest WiFi\n' +
          '📋 <b>My Open Jira Tickets</b> — your open tickets, paginated\n' +
          '🧠 <b>Create / Gogo Kitten Brain</b> — your private memory\n' +
          '⏰ <b>Reminder settings</b> — configure all reminder features\n' +
          '⏱️ <b>My reminders</b> — see & cancel your one-off reminders\n' +
          '❓ <b>What can I do?</b> — this overview\n\n' +
          '📚 Plus the <b>FAQ live search</b> field at the top of the menu.'
      }
    }]
  };
}

function buildFunctionsCardObject(settings, hasBrain, tab = 'standard') {
  // Side-nav layout (like Google's own settings dialogs): tab buttons
  // stacked vertically in a narrow LEFT column, content in the RIGHT column.
  // The current tab is disabled (= greyed out, "you are here").
  // All buttons live in ONE buttonList: in the narrow column each button
  // wraps onto its own line, tightly stacked (separate widgets would get
  // spread out over the whole column height).
  const navWidgets = [{
    buttonList: {
      buttons: FUNCTION_TABS.map(t => ({
        text: t.id === tab ? `▸ ${t.label}` : t.label,
        disabled: t.id === tab,
        onClick: buttonAction('show_functions_tab', false, [{ key: 'tab', value: t.id }])
      }))
    }
  }];
  const content = functionsTabContent(tab, settings, hasBrain);
  return {
    sections: [
      {
        header: '🐱 What IT Kitten can do',
        widgets: [
          {
            columns: {
              columnItems: [
                {
                  horizontalSizeStyle: 'FILL_MINIMUM_SPACE',
                  horizontalAlignment: 'START',
                  verticalAlignment: 'TOP',
                  widgets: navWidgets
                },
                {
                  horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
                  horizontalAlignment: 'START',
                  verticalAlignment: 'TOP',
                  widgets: [
                    { textParagraph: { text: `<b>${content.header}</b>` } },
                    ...content.widgets
                  ]
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

// ---------- ⏱️ "My reminders" dialog ----------
// reminders: [{ row, when, text }] — `row` is the sheet row (stable id for
// the cancel button), `when` is the already-formatted Berlin timestamp.
// Cancel buttons re-render this dialog via cancel_reminder_row.
function buildMyRemindersCardObject(reminders, hasBrain = true) {
  const widgets = [];
  if (!hasBrain) {
    widgets.push({
      textParagraph: {
        text:
          '🧠 Your reminders live in your <b>Kitten Brain</b> — and you don\'t have one yet.\n\n' +
          'Close this popup and click <b>🧠 Create Kitten Brain</b> in the menu first, ' +
          'then set a reminder, e.g.: <b>remind me in 2 hours to check the deploy</b>'
      }
    });
  } else if (!reminders.length) {
    widgets.push({
      textParagraph: {
        text:
          'You have no open reminders. 🎉\n\n' +
          'Create one by writing me e.g.:\n<b>remind me in 2 hours to check the deploy</b>\n' +
          '(times like "at 15:30", "tomorrow at 9" or "on friday" work too)'
      }
    });
  } else {
    widgets.push({ textParagraph: { text: 'Your open one-off reminders — cancel any of them right here:' } });
    reminders.forEach((r, i) => {
      widgets.push({
        decoratedText: {
          topLabel: `#${i + 1} · ${r.when} (Berlin)`,
          text: r.text,
          wrapText: true,
          button: {
            text: '🗑️ Cancel',
            onClick: buttonAction('cancel_reminder_row', false, [{ key: 'row', value: String(r.row) }])
          }
        }
      });
    });
    widgets.push({
      textParagraph: {
        text: '<font color="#80868B">Tip: in chat, <b>my reminders</b> shows this list and <b>cancel reminder</b> + its number cancels one.</font>'
      }
    });
  }
  return { sections: [{ header: '⏱️ My reminders', widgets }] };
}

// ---------- 🛠️ Admin dialog ----------
// jobs: [{ value, label }] of prepared announcements; previewText is the
// template of the selected one (with a {firstName} placeholder shown as-is).
function buildAdminCardObject(jobs, selectedJob, previewText) {
  return {
    sections: [
      {
        header: '📣 Prepared announcements — send to EVERYONE',
        widgets: [
          {
            selectionInput: {
              name: 'admin_job',
              type: 'DROPDOWN',
              label: 'Which message?',
              items: jobs.map(j => ({ text: j.label, value: j.value, selected: j.value === selectedJob })),
              onChangeAction: buttonAction('admin_select_job').action
            }
          },
          { textParagraph: { text: `<i><font color="#80868B">${previewText}</font></i>` } },
          {
            textInput: {
              label: '🔑 Security key',
              type: 'SINGLE_LINE',
              name: 'admin_key'
            }
          },
          {
            buttonList: {
              buttons: [{ text: '🚀 Send to everyone', onClick: buttonAction('admin_send_job') }]
            }
          }
        ]
      },
      {
        header: '📢 Custom broadcast — send to EVERYONE',
        widgets: [
          {
            textInput: {
              label: 'Your message',
              type: 'MULTIPLE_LINE',
              name: 'admin_custom_msg'
            }
          },
          {
            textInput: {
              label: '🔑 Security key',
              type: 'SINGLE_LINE',
              name: 'admin_key2'
            }
          },
          {
            buttonList: {
              buttons: [{ text: '📢 Send broadcast to everyone', onClick: buttonAction('admin_send_custom') }]
            }
          }
        ]
      },
      {
        header: '🧪 Testing area — send to ONE person only',
        widgets: [
          {
            textInput: {
              label: 'Tester email',
              type: 'SINGLE_LINE',
              name: 'admin_test_email'
            }
          },
          {
            textInput: {
              label: '🔑 Security key',
              type: 'SINGLE_LINE',
              name: 'admin_test_key'
            }
          },
          {
            textInput: {
              label: 'Test message',
              type: 'MULTIPLE_LINE',
              name: 'admin_test_msg'
            }
          },
          {
            buttonList: {
              buttons: [{ text: '🧪 Send test DM', onClick: buttonAction('admin_send_test') }]
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
  // replace the card of the CURRENTLY OPEN dialog (tab switches, previews)
  updateDialog: cardObject => ({
    action: { navigations: [{ updateCard: cardObject }] }
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
  updateDialog: cardObject => ({
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
  buildMyRemindersCardObject,
  buildAdminCardObject,
  buildTaskDialogCardObject,
  buildTaskOfferMessage,
  answerTextFor,
  extractUrls,
  isLinkOnlyAnswer,
  wrappers,
  KITTEN_VERSION
};
