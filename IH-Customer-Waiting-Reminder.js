// IH-Customer-Waiting-Reminder.js — ported from the Slack version.
// Daily: finds IH tickets in "Waiting for customer" for >1 day and reminds the
// reporter via DM in Google Chat. Skips weekends and tickets whose last
// comment contains "hold". Optionally CCs Marcus.
//
// NOTE: a Chat app can only DM users who already have a DM with it. If a
// reporter never talked to the Kitten, the DM fails → a fallback notice is
// posted into the internal support space (REPORT_SPACE_ID).
//
// Env: MARCUS_EMAIL (default marcus.gallein@urbansportsclub.com),
//      SEND_COPY_TO_MARCUS=1|0 (default 1), REPORT_SPACE_ID (fallback space)

const axios = require('axios');
const { sendDm, postToSpace } = require('./Chat-Poster');

const MARCUS_EMAIL = process.env.MARCUS_EMAIL || 'marcus.gallein@urbansportsclub.com';
const SEND_COPY_TO_MARCUS = process.env.SEND_COPY_TO_MARCUS !== '0';

const auth = Buffer.from(`${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`).toString('base64');
const baseUrl = process.env.JIRA_BASE_URL;

const jiraConfig = {
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
};

// Tickets in "Waiting for customer" untouched for over 1 day
async function getStaleWaitingTickets() {
  const jql = `project = IH AND status = "Waiting for customer" AND updated <= -1d`;
  const response = await axios.post(
    `${baseUrl}/rest/api/3/search/jql`,
    { jql, fields: ['summary', 'key', 'reporter'], fieldsByKeys: true, maxResults: 100 },
    jiraConfig
  );
  return response.data.issues || [];
}

// Last comment contains "hold"?
async function isOnHold(ticketKey) {
  const url = `${baseUrl}/rest/api/3/issue/${ticketKey}/comment?orderBy=-created&maxResults=1`;
  try {
    const response = await axios.get(url, jiraConfig);
    const comments = response.data.comments;
    if (!comments || comments.length === 0) return false;

    const body = comments[0].body;
    let text = '';
    if (typeof body === 'object' && body?.content) {
      for (const block of body.content) {
        if (block.content) {
          for (const inner of block.content) {
            if (inner.type === 'text' && inner.text) text += inner.text + ' ';
          }
        }
      }
    }
    return text.trim().toLowerCase().includes('hold');
  } catch (err) {
    console.error(`⚠️ Error checking comment for ${ticketKey}:`, err.message);
    return false;
  }
}

async function remindReporter(email, ticket) {
  const ticketUrl = `${baseUrl}/browse/${ticket.key}`;
  const text =
    `👋 Hi! Just a heads-up: Your Jira ticket *${ticket.key}* – *${ticket.fields.summary}* ` +
    `has been in *Waiting for customer* for more than 1 day.\n\n` +
    `Could you please follow up when you have a moment? Thanks!\n` +
    `🔗 <${ticketUrl}|View Ticket>`;

  const ok = await sendDm(email, text);

  if (ok) {
    console.log(`✅ Reminder sent to ${email} for ticket ${ticket.key}`);
    if (SEND_COPY_TO_MARCUS && email !== MARCUS_EMAIL) {
      await sendDm(MARCUS_EMAIL, `📎 *Copy of reminder for ticket ${ticket.key}:*\n${text}`);
    }
  } else if (process.env.REPORT_SPACE_ID) {
    await postToSpace(
      process.env.REPORT_SPACE_ID,
      `⚠️ Could not DM ${email} for *${ticket.key}* (no DM with IT Kitten yet). Please follow up manually: <${ticketUrl}|${ticket.key}>`
    );
  }
}

// ✅ Named runner
async function runReminderScript() {
  const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) {
    console.log('📅 Weekend detected. No reminders will be sent.');
    return;
  }

  const tickets = await getStaleWaitingTickets();
  console.log(`🔍 Found ${tickets.length} tickets awaiting customer > 1 day`);

  for (const ticket of tickets) {
    const email = ticket.fields.reporter?.emailAddress;
    if (!email) {
      console.log(`⛔ Ticket ${ticket.key} has no reporter email.`);
      continue;
    }
    if (await isOnHold(ticket.key)) {
      console.log(`⏸ Ticket ${ticket.key} skipped (last comment = hold).`);
      continue;
    }
    await remindReporter(email, ticket);
  }

  console.log('✅ All reminders processed.');
}

module.exports = { run: runReminderScript };
