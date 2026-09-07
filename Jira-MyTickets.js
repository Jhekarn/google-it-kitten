// Jira-MyTickets.js — "My Open Jira Tickets" (ported from the Slack version).
// Fetches all open tickets reported by the user across all projects and
// renders them as paginated card text with clickable links.

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
      maxResults: 100
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

// Render one PAGE of the ticket list as Chat card text (links clickable).
// Returns { text, page, totalPages } for the pagination buttons.
const PAGE_SIZE = 15;

function buildMyTicketsPage(tickets, page = 0) {
  if (!tickets.length) {
    return { text: '📭 You have no open Jira tickets.', page: 0, totalPages: 1 };
  }

  const totalPages = Math.ceil(tickets.length / PAGE_SIZE);
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = tickets.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const lines = slice.map(t =>
    `• <a href="${t.url}">${t.key}</a> — ${t.summary} <i>(Status: ${t.status}, Assignee: ${t.assignee})</i>`
  );

  const header =
    totalPages > 1
      ? `📋 <b>Your open Jira tickets (${tickets.length} total — page ${p + 1} of ${totalPages}):</b>`
      : `📋 <b>Your open Jira tickets across all projects:</b>`;

  return { text: `${header}\n\n` + lines.join('\n'), page: p, totalPages };
}

module.exports = { getUserOpenTickets, buildMyTicketsPage, PAGE_SIZE };
