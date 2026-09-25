google-it-kitten 🐱

USC internal IT Kitten — the IT assistant in Google Chat (successor of the Slack Kitten, which it has fully replaced).

Status: live in production for the whole company — currently at v2.9 (the Kitten shows its exact version at the bottom of its menu). It answers IT questions with AI, searches the FAQ live, creates Jira tickets & service requests, remembers things in your private Kitten Brain, sends reminders and a morning brief, plans meetings, finds free time slots — and writes first when a ticket is waiting on you.

How to read the version number: 1st digit = platform generation (1.x Slack, 2.x Google Chat), 2nd digit = big feature releases, 3rd digit = small updates within a release. Full history in RELEASE-NOTES.md.

What it does
🤖 AI answers (Gemini / Vertex AI) — free-text questions in any language, grounded in USC's own FAQ sheet with fixed house rules. Helps first; offers a ticket second.
🎫 Tickets — creates real JSM service requests for IT Helpdesk & Security and normal Jira issues for SRE & DevX, with you as the reporter. Quick Ticket: describe your problem in chat, and if the Kitten can't solve it, one button opens the form prefilled (title, description, what you tried, team preselected). Plus "my open tickets".
📚 Live FAQ — the knowledge base is a Google Sheet; search suggests answers while you type, edits go live in about a minute.
🧠 Kitten Brain — private memory & settings, stored as a small sheet in your own Google Drive. remember … to teach it, delete the row to make it forget.
⏰ Reminders & morning brief — one-off reminders ("remind me tomorrow at 9 to…"), a daily digest of your Google Tasks due today, and an optional morning overview of your meetings.
📅 Meetings — create calendar events with a Meet link by chat, or find a time when everyone is free (single day or the whole work week — free/busy only, never event details).
📨 Proactive jobs — daily nudges for Jira tickets waiting on your reply, the Monday satisfaction report for IT, and an error watchdog that reports into an IT monitoring space.
Architecture in one sentence

Google Chat delivers every tap & message as a signed event to POST /chat; server.js verifies it (Chat-Auth), routes it to one of the modules below, and hands back cards, dialogs or plain messages — everything else lives behind seven carefully-fenced connections (Chat API, Jira Cloud, Sheets, Vertex AI, Drive, Calendar/Tasks, Directory).

Files
File	Job
server.js	Express server & hub: receives events on POST /chat, understands both Chat event formats, routes every click/command/message, holds the RAM-only short-term chat memory (1 h), runs all schedules.
Chat-Auth.js	The doorman: verifies Google's ID token on every request — fakes are dropped unread.
Menu-Card.js	The face: the whole kitten menu, all tabs, every dialog (tickets incl. prefill, settings, meetings, admin), version footer.
Gemini-Handler.js	The voice: AI answers via Vertex AI — structured output (answer + optional ticket draft), help-first policy, fail-safe fallback to plain text.
FAQ-DB.js / GoogleSheet-Handler.js	Knowledge base: live FAQ search & FAQ submissions on top of Google Sheets.
Jira.js / Jira-MyTickets.js	Tickets: JSM service requests (IT & Security) + Jira issues (SRE & DevX), reporter mapping, portal links, open-tickets list.
Kitten-Brain.js	Private memory & settings in the user's own Drive (drive.file — the Kitten can only ever touch files it created itself).
Kitten-Reminders.js / Kitten-Brief.js / Kitten-Tasks.js	One-off reminders, morning day-brief, Google Tasks creation (create only — it never deletes or completes anything).
Kitten-Meetings.js	Plan a meeting (with Meet link) & find-a-time via free/busy — create only, never edit/delete.
Chat-Poster.js	Sends proactive DMs as the app (via a read-only Directory lookup: work email → chat user ID).
IH-Customer-Waiting-Reminder.js	Daily job: DM reporters whose Jira tickets wait on their reply.
IH-Project-Satisfaction-WeeklyReport.js	Monday job: last week's ticket satisfaction summary for the IT team.
test/send-test-event.js	Local smoke test, fakes Chat events (npm run test-event).
Docs
KITTEN-DOCUMENTATION.md — full technical documentation incl. the platform rules we learned the hard way.
MIGRATION-GUIDE.md — how to move the whole Kitten to another Google Workspace org in 1–2 hours of configuration, no code changes.
ADMIN-GUIDE.md — the admin menu, broadcasts, scheduled-job test switches.
RELEASE-NOTES.md — what shipped, version by version.
Privacy by design

Memories, settings and reminder texts live in your own Google Drive, not on the server. The AI's short-term chat memory is RAM-only and fades after an hour — nothing is ever written to disk. Free/busy checks never see event details, the directory lookup is read-only, and the Kitten never deletes or edits anything it didn't create. Conversations are not used to train any AI model.

Run locally
npm install
cp .env.example .env        # set SKIP_CHAT_VERIFICATION=1 for local testing
npm start
npm run test-event          # in a second terminal

All configuration lives in environment variables — no secrets in this repo, ever (it's public).

Deploy

Render web service, build npm install, start npm start. Put the public URL + /chat into the Chat API configuration AND into CHAT_APP_AUDIENCE. GCP/Chat API setup, scopes & domain-wide delegation are described step by step in the docs above.

Developed by Marcus Gallein. If anything breaks, ask me — or use the 🐞 Report a Bug link in the Kitten's menu.
