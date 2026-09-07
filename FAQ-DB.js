// FAQ-DB.js — reads the FAQ knowledge base from Google Sheets.
// Ported from the Slack version. FAQ data lives here:
// https://docs.google.com/spreadsheets/d/1-Y6YUWMG8HAXov_2i77z5l-SKqyswym5-RZhTbyrXAs
//   Tab "FAQ DB", column A = suggestion (title), column B = response text.
//
// Slack used external_select live autocomplete; Google Chat has no equivalent,
// so the flow is: search field on the help card → matches as buttons → click
// shows the answer. Results are cached for 60s to keep Sheet API calls low.

const { getSheetsClient } = require('./GoogleSheet-Handler');

const FAQ_SHEET_ID = process.env.FAQ_SHEET_ID || '1-Y6YUWMG8HAXov_2i77z5l-SKqyswym5-RZhTbyrXAs';
const TAB_NAME = 'FAQ DB';
const CACHE_TTL_MS = 60 * 1000;

let cache = { at: 0, faqs: [] };

// Fetch all FAQs (cached)
async function fetchFAQs() {
  if (Date.now() - cache.at < CACHE_TTL_MS && cache.faqs.length) return cache.faqs;

  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: FAQ_SHEET_ID,
    range: `${TAB_NAME}!A2:B`
  });

  const rows = response.data.values || [];
  const faqs = rows
    .filter(([suggestion]) => suggestion && suggestion.trim())
    .map(([suggestion, responseText]) => ({
      suggestion: suggestion.trim(),
      value: suggestion.trim().toLowerCase().replace(/\s+/g, '_'),
      responseText: responseText || ''
    }));

  cache = { at: Date.now(), faqs };
  return faqs;
}

// Case-insensitive substring search (same matching as the Slack version)
async function searchFAQs(query) {
  const q = query.toLowerCase();
  const faqs = await fetchFAQs();
  return faqs.filter(f => f.suggestion.toLowerCase().includes(q));
}

// Look up a single FAQ by its value id
async function findFAQ(value) {
  const faqs = await fetchFAQs();
  return faqs.find(f => f.value === value) || null;
}

module.exports = { fetchFAQs, searchFAQs, findFAQ };
