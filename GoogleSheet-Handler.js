// GoogleSheet-Handler.js — Google Sheets automation for the Chat Kitten.
// Ported from the Slack version: appends submitted FAQs to the FAQ_SUBMITS tab.
//
// Env needed (same values as the Slack Kitten uses):
//   GOOGLE_CLIENT_EMAIL  — service account email
//   GOOGLE_PRIVATE_KEY   — service account private key (with \n escapes)
//   SPREADSHEET_ID       — the sheet holding the FAQ_SUBMITS tab
//
// The client is created lazily so the server still boots when the env vars
// aren't set yet (it then errors only when someone actually submits an FAQ).

const { google } = require('googleapis');

let sheetsClient = null;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY not set in env');
  }

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function appendFAQToSheet(title, helptext, requester) {
  if (!process.env.SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID not set in env');
  }

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'FAQ_SUBMITS!A:C',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[title, helptext, requester]]
    }
  });
}

module.exports = { appendFAQToSheet, getSheetsClient };
