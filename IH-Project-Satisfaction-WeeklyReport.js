// IH-Project-Satisfaction-WeeklyReport.js — ported from the Slack version.
// Weekly satisfaction report from the IH project in Jira, posted into the
// internal support space (REPORT_SPACE_ID) every Monday.
//
// Satisfaction field: customfield_11618 (rating 1-5).

const axios = require('axios');
const { postToSpace } = require('./Chat-Poster');

const auth = Buffer.from(`${process.env.JIRA_USER}:${process.env.JIRA_TOKEN}`).toString('base64');
const baseUrl = process.env.JIRA_BASE_URL;
const JIRA_PROJECT_KEY = 'IH';
const SATISFACTION_FIELD_ID = 'customfield_11618';

const jiraConfig = {
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
};

async function fetchClosedTicketsLastWeek() {
  const jql =
    `project = ${JIRA_PROJECT_KEY} AND statusCategory = Done ` +
    `AND updated >= -7d AND cf[11618] IS NOT EMPTY`;

  const url = `${baseUrl}/rest/api/3/search/jql`;
  const fields = ['summary', 'key', SATISFACTION_FIELD_ID];
  const maxResults = 100;

  const all = [];
  let nextPageToken = undefined;

  do {
    const body = { jql, fields, maxResults, ...(nextPageToken ? { nextPageToken } : {}) };
    const res = await axios.post(url, body, jiraConfig);
    if (Array.isArray(res.data.issues)) all.push(...res.data.issues);
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);

  return all;
}

function formatSatisfaction(value) {
  const num = typeof value === 'object' && value?.rating
    ? parseInt(value.rating, 10)
    : parseInt(value, 10);

  if (!isNaN(num) && num >= 1 && num <= 5) {
    return '⭐'.repeat(num) + ` (${num}/5)`;
  }
  return '❌ No feedback';
}

function calculateAverage(tickets) {
  const values = tickets
    .map(t => {
      const v = t.fields[SATISFACTION_FIELD_ID];
      return typeof v === 'object' && v?.rating ? parseInt(v.rating, 10) : parseInt(v, 10);
    })
    .filter(n => !isNaN(n) && n >= 1 && n <= 5);

  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Google Chat text messages support *bold* and <https://url|Label> links.
function buildChatMessage(tickets) {
  if (!tickets.length) {
    return `📊 No closed tickets found for project *${JIRA_PROJECT_KEY}* in the past 7 days.`;
  }

  const lines = tickets.map(issue => {
    const rating = formatSatisfaction(issue.fields[SATISFACTION_FIELD_ID]);
    const jiraUrl = `${baseUrl}/browse/${issue.key}`;
    return `• <${jiraUrl}|${issue.key}> – "${issue.fields.summary}" — ${rating}`;
  });

  const average = calculateAverage(tickets);
  let averageLine = '';
  if (average !== null) {
    const rounded = Math.round(average * 10) / 10;
    const stars = '⭐'.repeat(Math.round(rounded));
    averageLine = `\n\n📈 *Average Satisfaction:* ${stars} (${rounded}/5)`;
  }

  return `🎯 *Weekly Satisfaction Report – Project ${JIRA_PROJECT_KEY}*\n\n` + lines.join('\n') + averageLine;
}

async function runWeeklyReport() {
  const spaceId = process.env.REPORT_SPACE_ID;
  if (!spaceId) throw new Error('REPORT_SPACE_ID not set in env');

  const tickets = await fetchClosedTicketsLastWeek();
  const message = buildChatMessage(tickets);
  await postToSpace(spaceId, message);
  console.log(`🎯 Weekly report posted to ${spaceId} (${tickets.length} tickets).`);
}

module.exports = { runWeeklyReport };
