# Gmail Auto Reply

Local Node.js automation for **samiksha.t@otomeyt.ai** that detects Product Support Request emails where a candidate **cannot start** their assessment, and sends a tailored HTML reply to the candidate.

**Manager / stakeholder overview:** [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — step-by-step flow, Gmail API, OpenAI API, safety controls.

## What it processes

Only emails in **Samiksha’s Gmail inbox** (`samiksha.t@otomeyt.ai` via OAuth) that match **all** of:

1. **Inbox** — unread mail in the authorized account (default query: `in:inbox`)
2. **Format** — body contains a **Product Support Request** (`Candidate Email ID`, `Issue`, etc.)
3. **Issue type** — assessment **start** problem (keyword filter + OpenAI YES/NO when `OPENAI_API_KEY` is set)

Replies are sent **From** `samiksha.t@otomeyt.ai`, **To** the candidate email in the request, in the same Gmail thread.

## Setup

1. Place `credentials.json` (OAuth Desktop Client) in the project root.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
4. **OAuth:** sign in as **`samiksha.t@otomeyt.ai`** (delete `token.json` first if you used another account).
5. Run `npm start`.
6. With `DRY_RUN=true`, verify logs for real support emails in Samiksha’s inbox.
7. Set `DRY_RUN=false` only after verifying. Restart the app.

## Env

| Variable | Description |
|----------|-------------|
| `GMAIL_QUERY` | Base Gmail search (default `in:inbox`; poll also adds `is:unread`, `-label:Auto-Replied`) |
| `REPLY_FROM_EMAIL` | Sender on outbound replies (default `samiksha.t@otomeyt.ai`) |
| `REPLY_FROM_NAME` | Display name on From line (default `Samiksha`) |
| `PROCESSED_LABEL` | Label applied to thread after reply |
| `DRY_RUN` | `true` = log only; `false` = send + label + mark read |
| `POLL_INTERVAL_MS` | Poll interval in ms |
| `OPENAI_API_KEY` | Required to confirm assessment-start issues |
| `OPENAI_MODEL` | Model name (default `gpt-4o-mini`) |

## How replies work

1. **Poll** Samiksha’s inbox for unread, unlabeled Product Support Requests.
2. **Parse** candidate name, email, and `Issue` text.
3. **Classify** — start-issue only (not mid-test / reattempt).
4. **Reply** — to candidate, from `REPLY_FROM_EMAIL`; thread labeled and marked read so it is not processed again.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Poll inbox continuously |
| `npm run run-once` | Single poll |
| `npm run test:parse` | Local parse + keyword checks |
| `npm run test:dedup` | Mark-read / no-duplicate-reply guards |
| `npm run test:inbox` | Mixed-inbox safety (no Gmail/OpenAI) |
| `npm test` | Run all of the above |
| `node scripts/send-test-emails.js` | Send sample requests to Samiksha’s inbox |

If Gmail rejects the From address, re-authorize as `samiksha.t@otomeyt.ai` or add **Send mail as** in Gmail settings.
