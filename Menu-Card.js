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
const KITTEN_VERSION = '2.10.2';
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
    { text: '📅 Plan a meeting',               functionName: 'open_meeting_planner', opensDialog: true },
    { text: hasBrain ? '🧠 Gogo Kitten Brain' : '🧠 Create Kitten Brain', functionName: 'create_brain' }, // per-user private memory
    { text: '⏱️ My reminders',                 functionName: 'open_my_reminders', opensDialog: true },
    { text: '🔌 Automations',                  functionName: 'open_automations', opensDialog: true }, // N8N → space reports (v2.10.0)
    { text: '❓ What can I do?',               functionName: 'show_functions', opensDialog: true },
    { text: '⚙️ Settings',                     functionName: 'open_settings', opensDialog: true }
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
// `prefill` (since v2.9.0, all optional): { team, title, description, note } —
// used by the "🎫 Open a ticket for this" offer to open the dialog with the
// AI-drafted title/description and the suggested team preselected. The user
// reviews, adjusts the team if needed, and clicks Create.
function buildJiraDialogCardObject(prefill = {}) {
  const team = ['IH', 'SRE', 'DX', 'SECHELP'].includes(prefill.team) ? prefill.team : 'IH';
  return {
    sections: [
      {
        header: 'New Jira Ticket',
        widgets: [
          ...(prefill.note ? [{ textParagraph: { text: `<font color="#80868B">${prefill.note}</font>` } }] : []),
          {
            selectionInput: {
              name: 'jira_project',
              type: 'DROPDOWN',
              label: 'Which project is this for?',
              items: [
                { text: 'IT Helpdesk - #it-support', value: 'IH', selected: team === 'IH' },
                { text: 'SRE Team - #hive-platform-ask', value: 'SRE', selected: team === 'SRE' },
                { text: 'DevX Team - #hive-platform-ask', value: 'DX', selected: team === 'DX' },
                { text: 'Security Team - #security-ask', value: 'SECHELP', selected: team === 'SECHELP' }
              ]
            }
          },
          {
            textInput: {
              label: 'Ticket Title',
              type: 'SINGLE_LINE',
              name: 'jira_title',
              ...(prefill.title ? { value: prefill.title } : {})
            }
          },
          {
            textInput: {
              label: 'Ticket Description',
              type: 'MULTIPLE_LINE',
              name: 'jira_desc',
              ...(prefill.description ? { value: prefill.description } : {})
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

// Chat answer that carries the "🎫 Open a ticket for this" offer (v2.9.0):
// the AI answer as plain text (keeps *bold* chat formatting) + a small card
// with the button. The draft itself is cached server-side (too large for
// button parameters) — the click (open_ticket_draft) fetches it there.
function buildTicketOfferAnswerMessage(answerText) {
  return {
    text: answerText,
    cardsV2: [
      {
        cardId: 'ticket_offer',
        card: {
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      { text: '🎫 Open a ticket for this…', onClick: buttonAction('open_ticket_draft', true) }
                    ]
                  }
                },
                { textParagraph: { text: '<font color="#80868B">Opens prefilled with your issue — you just check the team and hit Create.</font>' } }
              ]
            }
          ]
        }
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

// ---------- ⚙️ Settings dialog (side navigation) ----------
// Two settings pages, stored in the SETTINGS tab of the user's own Kitten
// Brain sheet: ⏰ Reminder Settings and 📅 Meeting Settings. Same side-nav
// pattern as the "What can I do?" dialog (columns widget, current page
// disabled); nav clicks re-render via settings_tab + updateDialog.
const SETTINGS_TABS = [
  { id: 'reminders', label: '⏰ Reminder Settings' },
  { id: 'meetings',  label: '📅 Meeting Settings' }
];

const hourItems = (from, to, selectedHour) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const h = i + from;
    return { text: `${String(h).padStart(2, '0')}:00`, value: String(h), selected: Number(selectedHour) === h };
  });

function settingsTabContent(tab, settings) {
  if (tab === 'meetings') {
    return [
      {
        textParagraph: {
          text:
            '<b>📅 Meeting Settings</b>\n' +
            'The time window the Kitten searches when you ask it to <b>find a meeting time</b> ' +
            '("📅 Plan a meeting" → Find a time). Only slots inside this window are suggested. ' +
            'Berlin time — stored in the SETTINGS tab of your own Kitten Brain sheet.'
        }
      },
      {
        selectionInput: {
          name: 'meeting_start',
          type: 'DROPDOWN',
          label: '🕘 Search from (Berlin time)',
          items: hourItems(6, 20, settings.meeting_start ?? 9)
        }
      },
      {
        selectionInput: {
          name: 'meeting_end',
          type: 'DROPDOWN',
          label: '🕕 Search until (Berlin time)',
          items: hourItems(7, 22, settings.meeting_end ?? 18)
        }
      },
      { textParagraph: { text: '<font color="#80868B">Default: 09:00 – 18:00.</font>' } },
      {
        buttonList: {
          buttons: [{ text: 'Save', onClick: buttonAction('meeting_settings_submit') }]
        }
      }
    ];
  }

  // default: reminder settings
  return [
    {
      textParagraph: {
        text:
          '<b>⏰ Reminder Settings</b>\n' +
          'Stored in the <b>SETTINGS</b> tab of your own Kitten Brain sheet — your memories are untouched.'
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
        items: hourItems(6, 20, settings.digest_hour ?? 8)
      }
    },
    {
      buttonList: {
        buttons: [{ text: 'Save', onClick: buttonAction('reminder_settings_submit') }]
      }
    }
  ];
}

function buildSettingsCardObject(settings, tab = 'reminders') {
  const navWidgets = [{
    buttonList: {
      buttons: SETTINGS_TABS.map(t => ({
        text: t.id === tab ? `▸ ${t.label}` : t.label,
        disabled: t.id === tab,
        onClick: buttonAction('settings_tab', false, [{ key: 'tab', value: t.id }])
      }))
    }
  }];
  return {
    sections: [
      {
        header: '⚙️ Settings',
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
                  widgets: settingsTabContent(tab, settings)
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

// ---------- 🔌 Automations dialog (N8N → space reports, v2.10.0) ----------
// Two tabs, same side-nav pattern as ⚙️ Settings: existing connections of
// THIS user (with revoke buttons) and the setup form for a new one. Data is
// loaded server-side and passed in: { connections, spaces }.
//   connections: [{ row, name, spaceLabel, created, url }]
//   spaces:      [{ id, label }] — spaces BOTH the Kitten AND the user are
//                members of (v2.10.2 — membership-filtered server-side)
const AUTOMATION_TABS = [
  { id: 'existing', label: '🔗 Existing connections' },
  { id: 'setup',    label: '➕ Set up new connection' }
];

function automationsTabContent(tab, data) {
  if (tab === 'setup') {
    const widgets = [
      {
        textParagraph: {
          text:
            '<b>➕ Connect an N8N workflow</b>\n' +
            'Any N8N automation can report into a Google space through me. You need a ' +
            '<b>connector code</b> from IT (ask in #it-support) — one code per connection. ' +
            'After connecting you get a webhook URL to paste into your N8N workflow\'s HTTP node.'
        }
      },
      {
        textInput: {
          label: '🔑 Connector code (from IT)',
          type: 'SINGLE_LINE',
          name: 'n8n_code'
        }
      },
      {
        textInput: {
          label: '🏷️ Name for this connection (shown as the report header)',
          type: 'SINGLE_LINE',
          name: 'n8n_name'
        }
      },
      {
        textInput: {
          label: '🔗 Link to the N8N workflow (for reference)',
          type: 'SINGLE_LINE',
          name: 'n8n_link'
        }
      }
    ];
    if (data.spaces.length) {
      widgets.push({
        selectionInput: {
          name: 'n8n_space',
          type: 'DROPDOWN',
          label: '📢 Report into which space?',
          items: data.spaces.slice(0, 100).map((s, i) => ({ text: s.label, value: s.id, selected: i === 0 }))
        }
      });
      widgets.push({
        textParagraph: {
          text: '<font color="#80868B">Only spaces BOTH you and I are members of are listed — missing one? Make sure you\'re in the space, add me to it too, then reopen this dialog. Reports will ONLY ever go to the space you pick here.</font>'
        }
      });
      widgets.push({
        buttonList: { buttons: [{ text: '🔌 Connect', onClick: buttonAction('n8n_setup_submit') }] }
      });
    } else {
      widgets.push({
        textParagraph: {
          text: '⚠️ I don\'t see a space we\'re BOTH members of — make sure you\'re in the target space, add me to it as well, then reopen this dialog.'
        }
      });
    }
    return widgets;
  }

  // default: existing connections
  const widgets = [];
  if (!data.connections.length) {
    widgets.push({
      textParagraph: {
        text:
          'You have no N8N connections yet. 🔌\n\n' +
          'Switch to <b>➕ Set up new connection</b> to let one of your N8N workflows ' +
          'report into a Google space through me — you\'ll need a connector code from IT.'
      }
    });
  } else {
    widgets.push({ textParagraph: { text: 'Your active N8N connections — each one posts into its space through me:' } });
    for (const c of data.connections) {
      widgets.push({
        decoratedText: {
          topLabel: `since ${c.created}`,
          text: `<b>${c.name}</b>\n→ ${c.spaceLabel}\n<font color="#80868B">${c.url}</font>`,
          wrapText: true,
          button: {
            text: '🗑️ Revoke',
            onClick: buttonAction('n8n_revoke', false, [{ key: 'row', value: String(c.row) }])
          }
        }
      });
    }
    widgets.push({
      textParagraph: {
        text: '<font color="#80868B">Revoking stops delivery within a minute. The URL above is what your N8N workflow calls (POST, JSON {"title","text"} or plain text) — together with its X-Kitten-Secret header, which was shown once at setup. Lost the secret? Revoke + reconnect.</font>'
      }
    });
  }
  return widgets;
}

function buildAutomationsCardObject(data, tab = 'existing') {
  const navWidgets = [{
    buttonList: {
      buttons: AUTOMATION_TABS.map(t => ({
        text: t.id === tab ? `▸ ${t.label}` : t.label,
        disabled: t.id === tab,
        onClick: buttonAction('automations_tab', false, [{ key: 'tab', value: t.id }])
      }))
    }
  }];
  return {
    sections: [
      {
        header: '🔌 Automations (N8N)',
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
                  widgets: automationsTabContent(tab, data)
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

// Posted into the chat after a successful setup (also closes the dialog):
// confirmation + the inbound URL and the per-connection secret (v2.10.1,
// shown ONCE — it is not displayed anywhere again) for the N8N HTTP node.
function buildN8nConnectedMessage(name, url, spaceLabel, secret) {
  return {
    text: `✅ N8N connection "${name}" established`,
    cardsV2: [{
      cardId: 'n8n_connected',
      card: {
        sections: [{
          widgets: [
            {
              textParagraph: {
                text:
                  `✅ <b>${name}</b> is connected — I posted a test message into <b>${spaceLabel}</b>.\n\n` +
                  `Configure your N8N workflow's <b>HTTP Request node</b> with BOTH of these:\n\n` +
                  `<b>1 · URL</b> (method POST, body JSON like {"title":"optional","text":"your report"} — or plain text):`
              }
            },
            { textParagraph: { text: `<b>${url}</b>` } },
            {
              textParagraph: {
                text: `<b>2 · Header</b> — add a request header named <b>X-Kitten-Secret</b> with this value:`
              }
            },
            { textParagraph: { text: `<b>${secret || '(no secret — legacy connection)'}</b>` } },
            {
              textParagraph: {
                text:
                  '<font color="#80868B">⚠️ This secret is shown ONCE and never again — store it in N8N now. ' +
                  'Calls without the correct header are rejected, so a leaked URL alone is useless. ' +
                  'Lost the secret? Revoke this connection and set up a new one. ' +
                  'Manage or revoke any time: menu → 🔌 Automations.</font>'
              }
            }
          ]
        }]
      }
    }]
  };
}

// Posted to the admin after generating a connector code (🛠️ Admin area).
function buildN8nCodeMessage(code) {
  return {
    text: `🔌 New N8N connector code generated`,
    cardsV2: [{
      cardId: 'n8n_code',
      card: {
        sections: [{
          widgets: [
            {
              textParagraph: {
                text:
                  '🔌 Fresh connector code — share it with the requester (DM, not in a space!):'
              }
            },
            { textParagraph: { text: `<b>${code}</b>` } },
            {
              textParagraph: {
                text:
                  '<font color="#80868B">Single-use: the first person to connect with it claims it. ' +
                  'They connect via menu → 🔌 Automations → ➕ Set up new connection. ' +
                  'Revoke any time by clearing its status cell (or deleting the row) in the N8N sheet.</font>'
              }
            }
          ]
        }]
      }
    }]
  };
}

// ---------- 📅 "Plan a meeting" dialog (side navigation) ----------
// Two pages: Create event (title, start, duration, guests, description) and
// Find a time (date, duration, guests → free-slot suggestions). A Google
// Meet link is attached automatically; guests get normal Google invitations.
const MEETING_TABS = [
  { id: 'create', label: '📅 Create event' },
  { id: 'find',   label: '🔎 Find a time' }
];

const DURATION_ITEMS = (selected) => [15, 30, 45, 60, 90, 120].map(m => ({
  text: `${m} minutes`, value: String(m), selected: Number(selected) === m
}));

function meetingTabContent(tab, settings, prefill = {}) {
  if (tab === 'find') {
    const from = String(settings.meeting_start ?? 9).padStart(2, '0');
    const to = String(settings.meeting_end ?? 18).padStart(2, '0');
    return [
      {
        textParagraph: {
          text:
            'Pick a day (or a whole week), duration and guests — I check everyone\'s ' +
            '<b>free/busy status</b> (never event details) and suggest times where all are free. ' +
            'For a whole week I suggest the <b>best slot of each day</b>, Mon–Fri. ' +
            'Calendars I can\'t read (e.g. external guests) are reported and skipped.'
        }
      },
      {
        selectionInput: {
          name: 'find_range',
          type: 'DROPDOWN',
          label: 'Search range',
          items: [
            { text: '📅 Only this day', value: 'day', selected: true },
            { text: '🗓️ Whole work week (Mon–Fri)', value: 'week' }
          ]
        }
      },
      {
        dateTimePicker: {
          label: 'Day to search (for a whole week: any day of that week)',
          name: 'find_date',
          type: 'DATE_ONLY'
        }
      },
      {
        selectionInput: {
          name: 'find_duration',
          type: 'DROPDOWN',
          label: 'Meeting length',
          items: DURATION_ITEMS(prefill.duration || 60)
        }
      },
      {
        textInput: {
          label: 'Guests (emails, comma-separated)',
          type: 'SINGLE_LINE',
          name: 'find_guests',
          value: prefill.guests || ''
        }
      },
      {
        textParagraph: {
          text: `<font color="#80868B">Search window: ${from}:00 – ${to}:00 Berlin — change it under ⚙️ Settings → 📅 Meeting Settings.</font>`
        }
      },
      {
        buttonList: {
          buttons: [{ text: '🔎 Find free times', onClick: buttonAction('findtime_submit') }]
        }
      }
    ];
  }

  // default: create event
  return [
    {
      textInput: {
        label: 'Title',
        type: 'SINGLE_LINE',
        name: 'event_title',
        value: prefill.title || ''
      }
    },
    {
      dateTimePicker: {
        label: 'Start (date & time)',
        name: 'event_start',
        type: 'DATE_AND_TIME',
        ...(prefill.startMs ? { valueMsEpoch: String(prefill.startMs) } : {})
      }
    },
    {
      selectionInput: {
        name: 'event_duration',
        type: 'DROPDOWN',
        label: 'Duration',
        items: DURATION_ITEMS(prefill.duration || 60)
      }
    },
    {
      textInput: {
        label: 'Guests (emails, comma-separated — optional)',
        type: 'SINGLE_LINE',
        name: 'event_guests',
        value: prefill.guests || ''
      }
    },
    {
      textInput: {
        label: 'Description (optional)',
        type: 'MULTIPLE_LINE',
        name: 'event_desc'
      }
    },
    {
      textParagraph: {
        text: '<font color="#80868B">A Google Meet link is added automatically. All guests receive a normal Google Calendar invitation. The event lands in YOUR calendar.</font>'
      }
    },
    {
      buttonList: {
        buttons: [{ text: '📅 Create event', onClick: buttonAction('event_create_submit') }]
      }
    }
  ];
}

function buildMeetingPlannerCardObject(settings, tab = 'create', prefill = {}) {
  const navWidgets = [{
    buttonList: {
      buttons: MEETING_TABS.map(t => ({
        text: t.id === tab ? `▸ ${t.label}` : t.label,
        disabled: t.id === tab,
        onClick: buttonAction('meeting_planner_tab', false, [{ key: 'tab', value: t.id }])
      }))
    }
  }];
  return {
    sections: [
      {
        header: '📅 Plan a meeting',
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
                  widgets: meetingTabContent(tab, settings, prefill)
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

// Chat reply that offers to open the meeting planner (dialogs can only be
// opened from a button click — Chat platform rule).
function buildMeetingHubMessage() {
  return {
    text: '📅 Plan a meeting',
    cardsV2: [
      {
        cardId: 'meeting_hub',
        card: {
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      '📅 I can <b>create a calendar event</b> for you (with guests + automatic ' +
                      'Google Meet link) — or first <b>find a time</b> when all your guests are free.'
                  }
                },
                {
                  buttonList: {
                    buttons: [
                      { text: '📅 Create event…', onClick: buttonAction('open_meeting_planner', true, [{ key: 'tab', value: 'create' }]) },
                      { text: '🔎 Find a time…', onClick: buttonAction('open_meeting_planner', true, [{ key: 'tab', value: 'find' }]) }
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

// Free-slot results as a chat message: notice text + one button per slot.
// Each slot button opens the planner's Create page PREFILLED with that time,
// the duration and the guest list. slots: [{ label, startMs }].
function buildFindTimeResultsMessage(headerText, slots, durationMin, guestsCsv) {
  const widgets = [{ textParagraph: { text: headerText } }];
  if (slots.length) {
    widgets.push({
      buttonList: {
        buttons: slots.map(s => ({
          text: `🕐 ${s.label}`,
          onClick: buttonAction('open_meeting_planner', true, [
            { key: 'tab', value: 'create' },
            { key: 'startMs', value: String(s.startMs) },
            { key: 'duration', value: String(durationMin) },
            { key: 'guests', value: (guestsCsv || '').slice(0, 500) }
          ])
        }))
      }
    });
    widgets.push({ textParagraph: { text: '<font color="#80868B">Click a time to create the event — the form comes prefilled, you just add the title.</font>' } });
  }
  return {
    text: '🔎 Free time suggestions',
    cardsV2: [{ cardId: 'findtime_results', card: { sections: [{ widgets }] } }]
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
            '• Your ⚙️ Settings (reminders & meetings) are stored there too (SETTINGS tab)'
        }
      }]
    };
  }

  if (tab === 'reminders') {
    const mFrom = String(settings.meeting_start ?? 9).padStart(2, '0');
    const mTo = String(settings.meeting_end ?? 18).padStart(2, '0');
    return {
      header: '⏰ Reminders & meetings — features & your current setup',
      widgets: [{
        textParagraph: {
          text:
            '<b>What I can do:</b>\n' +
            '⏰ Daily "tasks due today" DM — your open Google Tasks every morning\n' +
            '🌅 Morning day-brief — today\'s meetings (+ tasks) in one morning DM\n' +
            '⏱️ One-off reminders — "remind me in 2 hours to ..." (see Chat commands)\n' +
            '📝 Create Google Tasks by chat — I never delete or complete tasks\n' +
            '📅 Create calendar events (auto Google Meet link, invitations to all guests)\n' +
            '🔎 Find a meeting time — one day (3 suggestions) or the whole work week Mon–Fri (best slot per day): I check the free/busy status of all guests and suggest slots where everyone is free (unreadable calendars, e.g. externals, are reported and skipped)\n\n' +
            '<b>Your current setup:</b>\n' +
            `🔔 Reminders (master switch): ${on(settings.reminders_enabled)}\n` +
            `⏰ Daily tasks DM (${hour}:00 Berlin): ${on(settings.daily_tasks)}\n` +
            `🌅 Morning day-brief (${hour}:00 Berlin): ${on(settings.morning_brief)}\n` +
            `📝 "create me a task ..." via chat: ${on(settings.task_create)}\n` +
            `📅 Meeting search window: ${mFrom}:00 – ${mTo}:00 (Berlin)\n\n` +
            `Change these: menu → ⚙️ Settings (⏰ Reminder Settings / 📅 Meeting Settings)${hasBrain ? '' : ' (needs a Kitten Brain first)'}`
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
            '<b>create me a task for</b> ordering a new cable — new Google Task (popup with optional date)\n' +
            '<b>create a meeting</b> / <b>find a time</b> — open the 📅 meeting planner (create events, find free slots)\n\n' +
            '<b>remember</b> I use a MacBook Pro — store a private memory (needs a Kitten Brain)\n' +
            '<b>forget</b> ... — I show you where to delete a memory\n\n' +
            '<b>remind me in 2 hours to</b> check the deploy — one-off reminder, stored privately ' +
            'in your Kitten Brain (times like "at 15:30", "tomorrow at 9", "on friday" or "on 24.12. at 10" work too)\n' +
            '<b>my reminders</b> — list your open reminders, each with a number\n' +
            '<b>cancel reminder</b> + the number from that list (e.g. <b>cancel reminder 1</b>) — cancel it. ' +
            'Or use the ⏱️ <b>My reminders</b> menu button and cancel with one click.\n\n' +
            '🤖 <b>Anything else</b> — free-text questions go to my AI brain (any language). I remember the ' +
            'last few messages of our chat, and if I can\'t solve your IT problem I\'ll offer a 🎫 button that ' +
            'opens a ticket already filled with your issue and what we tried — you just pick the team.'
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
          '📅 <b>Plan a meeting</b> — create calendar events (auto Meet link) or find a time when all guests are free (one day or the whole week)\n' +
          '🧠 <b>Create / Gogo Kitten Brain</b> — your private memory\n' +
          '⏱️ <b>My reminders</b> — see & cancel your one-off reminders\n' +
          '🔌 <b>Automations</b> — let your N8N workflows report into a Google space through me\n' +
          '❓ <b>What can I do?</b> — this overview\n' +
          '⚙️ <b>Settings</b> — Reminder Settings & Meeting Settings\n\n' +
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
// reminders: [{ row, when, text }] — `row` is the row in the USER'S OWN brain
// sheet (stable id for the cancel button), `when` is the already-formatted
// Berlin timestamp. Cancel buttons re-render this dialog via cancel_reminder_row.
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
        header: '🔌 N8N connector codes',
        widgets: [
          {
            textParagraph: {
              text:
                '<font color="#80868B">Generates a fresh single-use connector code in the N8N sheet ' +
                'and DMs it to you — share it with the requester. They connect via 🔌 Automations.</font>'
            }
          },
          {
            textInput: {
              label: '🔑 Security key',
              type: 'SINGLE_LINE',
              name: 'admin_n8n_key'
            }
          },
          {
            buttonList: {
              buttons: [{ text: '🔌 Generate connector code', onClick: buttonAction('admin_n8n_code') }]
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
  buildSettingsCardObject,
  buildAutomationsCardObject,
  buildN8nConnectedMessage,
  buildN8nCodeMessage,
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
  wrappers,
  KITTEN_VERSION
};
