// Jira-MyTickets.js — "My Open Jira Tickets" (ported from the Slack version).
// Fetches all open tickets reported by the user across all projects and
// renders them as one card text with clickable links.

const axios = require('axios');

const auth = Buffer.from(`${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`).toString('base64');
const baseUrl = process.env.JIRA_BASE_URL;

const config = {
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
};

// ✅ Fetch all open tickets reported by this user across all projects
async function getUserOpenTickets(email) {
  const jql = `reporter="${email}" AND statusCategory != Done ORDER BY created DESC`;

  const response = await axios.post(
    `${baseUrl}/rest/api/3/search/jql`,
    {
      jql,
      fields: ['summary', 'key', 'status', 'assignee'],
      fieldsByKeys: true,
      maxResults: 50
    },
    config
  );

  return (response.data.issues || []).map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status?.name || 'Unknown',
    assignee: issue.fields.assignee?.displayName || 'Unassigned',
    url: `${baseUrl}/browse/${issue.key}`
  }));
}

// Render the ticket list as Chat card text (links clickable)
function buildMyTicketsText(tickets) {
  if (!tickets.length) {
    return '📭 You have no open Jira tickets.';
  }

  const MAX_SHOWN = 15;
  const lines = tickets.slice(0, MAX_SHOWN).map(t =>
    `• <a href="${t.url}">${t.key}</a> — ${t.summary} <i>(Status: ${t.status}, Assignee: ${t.assignee})</i>`
  );

  let text = `📋 <b>Your open Jira tickets across all projects:</b>\n\n` + lines.join('\n');
  if (tickets.length > MAX_SHOWN) {
    text += `\n\n…and ${tickets.length - MAX_SHOWN} more.`;
  }
  return text;
}

module.exports = { getUserOpenTickets, buildMyTicketsText };
