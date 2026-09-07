# IT Kitten → Google Chat: Setup Guide & Migration Map

This guide gets the **foundation** live: Kitten answering in Google Chat with its help menu, buttons and a working dialog. Feature porting (Jira, FAQ search, cron reports) happens in the next steps on top of this.

---

## Part 1 — How Google Chat bots differ from Slack (read once)

| | Slack Kitten (today) | Google Chat Kitten |
|---|---|---|
| Connection | Socket Mode (bot dials out, no public URL needed) | Google **pushes** every event to a public HTTPS endpoint (`POST /chat` on Render) |
| Auth for replies | Bot token | None needed — the JSON you return to the POST **is** the reply |
| Auth for proactive messages (cron, DMs) | Bot token | Chat REST API with your existing **GCP service account** (`GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`) — later step |
| Request security | Signing secret | Google-signed ID token, verified in `Chat-Auth.js` |
| UI | Block Kit | **Cards v2** |
| Modals | `views.open` | **Dialogs** (a card returned with `actionResponse: DIALOG`) |
| Slash commands | Defined in Slack app config | Defined in Chat API config, each with a **numeric command ID** (we use 1 = /kitten, 2 = /submit-faq) |
| ⚠️ Message visibility | Bot can read all channel messages | Bot **only** receives DMs and messages that **@mention** it. Bare `kitten` keyword only works in DMs; in spaces users type `@IT Kitten` or `/kitten`. This also affects the Jira-Linkback feature (see migration map). |

## Part 2 — Google Cloud setup (one time, ~15 min)

You already have a GCP project with the Sheets service account — reuse that project.

1. **Enable the Chat API**: Google Cloud console → *APIs & Services → Library* → search "Google Chat API" → **Enable**.
2. **Configure the app**: *APIs & Services → Google Chat API → Configuration* tab:
   - **App name:** `IT Kitten`
   - **Avatar URL:** an HTTPS link to a square PNG/JPEG (you can reuse the Slack kitten avatar — upload it to Drive/public host).
   - **Description:** `USC internal IT helper`
   - **Interactive features:** enable. Check **Receive 1:1 messages** and **Join spaces and group conversations**.
   - **Connection settings:** choose **HTTP endpoint URL** and enter your Render URL + `/chat`, e.g. `https://google-it-kitten.onrender.com/chat`.
   - **Authentication Audience:** select **HTTP endpoint URL** (this is what `Chat-Auth.js` verifies).
   - **Commands** (called slash commands): *Add a command* twice:
     - ID `1`, slash command, name `/kitten`, description `Show the IT Kitten help menu`
     - ID `2`, slash command, name `/submit-faq`, description `Submit a new FAQ`, ✔ *Opens a dialog* if offered
   - **Visibility:** make the app available to your domain (`urbansportsclub.com`) or start with just yourself for testing.
   - **Save.**
3. **Logging (optional but useful):** enable *Log errors to Logging* in the same config page.

> The service account key you already use for Sheets stays as-is. In a later step we add the `chat.bot` scope usage for proactive messages (cron reports) — no new key needed.

## Part 3 — Render deployment

1. New **Web Service** on Render (Node), repo = this project.
   - Build: `npm install` — Start: `npm start`
2. Environment variables (Render → Environment):
   - `CHAT_APP_AUDIENCE` = `https://<your-service>.onrender.com/chat` (must match the URL configured in Part 2 **exactly**)
   - do **not** set `SKIP_CHAT_VERIFICATION` on Render
3. Deploy, then open `https://<your-service>.onrender.com/` in a browser → you should see "🐱 IT Kitten for Google Chat is running."
4. If the Render URL wasn't known when you did Part 2, go back and paste it into the Chat API config now.

## Part 4 — Test in Google Chat

1. In Google Chat → *New chat* → search **IT Kitten** (Apps section) → start a DM.
2. Type `kitten` → the help menu card should appear.
3. Click **HowTo section** → the card updates with the knowledge-base answer.
4. Click **Submit a New FAQ** → a dialog opens; submit it → confirmation (echo only for now).
5. Add the app to a test space → try `@IT Kitten kitten` and `/kitten`.

If nothing answers: Render logs first (did the POST arrive?), then check that `CHAT_APP_AUDIENCE` matches the configured endpoint URL character-for-character.

## Part 5 — Migration map (the next steps)

| Step | Slack file | What changes for Google Chat |
|---|---|---|
| 2 | GoogleSheet-Handler.js | Nearly unchanged (already Google APIs). Hook FAQ dialog submit → append to Sheet. Requester name comes from `event.user.displayName` (no users.info call needed). |
| 3 | FAQ-DB.js dynamic search | Chat has no `external_select` with live autocomplete in normal cards. Plan: text input + submit → card shows matching FAQ entries as buttons. |
| 4 | Menu buttons real answers | Replace placeholders in Menu-Card.js (WiFi text etc. — copy from Slack version). |
| 5 | Jira.js + ticket dialog | Jira.js unchanged. Modal → dialog. Reporter email comes from `event.user.email` (Workspace apps get it directly). Confirmation DM → reply in the same DM/space or via Chat REST API. |
| 6 | Jira-MyTickets.js | Same Jira call; response as card list. Ephemeral equivalent = `privateMessageViewer` reply. |
| 7 | Cron jobs (weekly report, IH reminder) | node-cron stays. Posting needs the Chat REST API (service account) + the target **space ID**; DMs to users via their email → `spaces.findDirectMessage`. |
| 8 | SlackToJiraLinkback.js | ⚠️ Needs redesign: the bot can't passively read space messages. Options: (a) change the Jira automation webhook to @mention Kitten, (b) let the Jira automation comment the Chat message link itself, (c) drop it. Decide when we get there. |
| — | broadcast.js | Same idea: small script using the Chat REST API to post into the it-support space. |

Developed with Marcus Gallein. Foundation built 2026-09-07.
