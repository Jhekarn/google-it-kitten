# google-it-kitten 🐱

USC internal IT Kitten Bot — **Google Chat / Google Spaces version** (successor of the Slack Kitten on Render).

**Status: Foundation phase.** The platform plumbing works end-to-end (events in, cards out, dialogs, buttons); the real features (Jira, Google Sheets FAQ, cron reports) get ported step by step and currently answer with placeholders.

## Files

- **server.js** — Express server, receives Google Chat events on `POST /chat`, routes them (equivalent of the old server.js + Bolt).
- **Chat-Auth.js** — verifies every request really comes from Google Chat (ID token check). Slack's signing secret equivalent.
- **Menu-Card.js** — the help menu as a Cards v2 card + the FAQ demo dialog (equivalent of Menu-Buttons.js / getHelpMenu). Same action ids as in Slack so porting maps 1:1.
- **test/send-test-event.js** — local smoke test, fakes Chat events (`npm run test-event`).
- **SETUP-GUIDE.md** — click-by-click GCP / Chat API / Render setup + the Slack→Google Chat migration map for the next steps.

## Run locally

```
npm install
cp .env.example .env        # set SKIP_CHAT_VERIFICATION=1 for local testing
npm start
npm run test-event          # in a second terminal
```

## Deploy

Render web service, build `npm install`, start `npm start`. Then put the public URL + `/chat` into the Chat API configuration AND into `CHAT_APP_AUDIENCE`. Full steps in SETUP-GUIDE.md.

Developed by Marcus Gallein. If anything breaks ask me.
