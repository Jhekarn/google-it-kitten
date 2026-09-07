// test/send-test-event.js — local smoke test without Google Chat.
// Run the server with SKIP_CHAT_VERIFICATION=1, then: npm run test-event
// It POSTs the three main event types and prints the bot's JSON answers.

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

const events = [
  {
    label: 'MESSAGE "kitten" (DM keyword)',
    body: {
      type: 'MESSAGE',
      space: { type: 'DM' },
      message: { text: 'kitten', argumentText: 'kitten' },
      user: { displayName: 'Test User' }
    }
  },
  {
    label: 'MESSAGE /kitten slash command',
    body: {
      type: 'MESSAGE',
      space: { type: 'ROOM' },
      message: { text: '/kitten', slashCommand: { commandId: '1' } },
      user: { displayName: 'Test User' }
    }
  },
  {
    label: 'CARD_CLICKED option_2 (HowTo)',
    body: {
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'option_2' },
      user: { displayName: 'Test User' }
    }
  },
  {
    label: 'CARD_CLICKED FAQ dialog submit',
    body: {
      type: 'CARD_CLICKED',
      isDialogEvent: true,
      dialogEventType: 'SUBMIT_DIALOG',
      common: {
        invokedFunction: 'faq_dialog_submit',
        formInputs: {
          faq_title: { stringInputs: { value: ['Printer setup'] } },
          faq_helptext: { stringInputs: { value: ['Go to Settings > Printers ...'] } }
        }
      },
      user: { displayName: 'Test User' }
    }
  }
];

(async () => {
  for (const { label, body } of events) {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    console.log(`\n=== ${label} (HTTP ${res.status}) ===`);
    console.log(JSON.stringify(json, null, 2).slice(0, 1500));
  }
})();
