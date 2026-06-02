# Gmail Auto-Reply — How It Works

**Audience:** Managers and non-technical stakeholders  
**System:** Automated replies for candidates who **cannot start** their online assessment  
**Mailbox:** `samiksha.t@otomeyt.ai` (Google Workspace)

---

## 1. Executive summary

This is a small **Node.js application** that runs continuously on a server or workstation. It watches Samiksha’s Gmail inbox for **Product Support Request** emails, checks whether the candidate’s issue is specifically about **not being able to start** the assessment, and if so sends a **professional HTML email** to the candidate from Samiksha’s address.

It does **not** reply to all emails in the inbox. Most mail (meetings, HR, general threads) is ignored automatically.

| Item | Detail |
|------|--------|
| **Runtime** | Node.js 18+ (local or server) |
| **Email access** | Google Gmail API (OAuth 2.0) |
| **AI used for** | (1) Confirm issue type, (2) Draft tailored reply text |
| **Typical poll interval** | Every 30 seconds (configurable) |
| **Duplicate prevention** | Gmail label `Auto-Replied` + mark thread as read |

---

## 2. Business problem and solution

### Problem

Support receives **Product Support Request** notifications when a candidate cannot proceed. Many issues share the same first-step fix (camera/microphone permissions, Chrome, incognito, alternate device). Replying manually is repetitive for clear **“cannot start”** cases.

### Solution

Automate only the **narrow** case:

- Email matches the **Product Support Request** structure (candidate name, email, issue text, etc.).
- Issue is about **starting** the assessment (not mid-test, reattempt, or unrelated topics).
- Send a consistent, professional reply **to the candidate’s email** from **Samiksha’s** address.
- Mark the thread handled so the same ticket is **not answered twice**.

---

## 3. High-level architecture

```mermaid
flowchart TB
    subgraph External["External services"]
        Gmail[Gmail API<br/>Google Cloud]
        OpenAI[OpenAI API<br/>Chat Completions]
    end

    subgraph App["gmail-auto-reply app"]
        Poll[Poll loop<br/>every N seconds]
        Parse[Parse Product Support Request]
        Gate[Classify: start issue?]
        Gen[Generate HTML reply]
        Send[Send email via Gmail]
        Finalize[Label + mark read]
    end

    Inbox[(samiksha.t@otomeyt.ai<br/>Inbox)]

    Inbox --> Poll
    Poll --> Gmail
    Gmail --> Parse
    Parse --> Gate
    Gate --> OpenAI
    Gate --> Gen
    Gen --> OpenAI
    Gen --> Send
    Send --> Gmail
    Send --> Finalize
    Finalize --> Gmail
    Gmail --> Inbox
```

---

## 4. Step-by-step: what happens on each poll

### Step 0 — Application startup (once)

1. Load settings from `.env` (poll interval, dry-run mode, API keys, etc.).
2. Load **OAuth credentials** from `credentials.json` (Google Cloud project).
3. Load or create **access token** from `token.json` (created when Samiksha signs in once).
4. Ensure Gmail label **`Auto-Replied`** exists.

### Step 1 — Find candidate emails (Gmail API)

Every **30 seconds** (default), the app searches the inbox with a query equivalent to:

```text
in:inbox after:<today> -label:Auto-Replied is:unread
```

Only **unread** messages **without** the `Auto-Replied` label are considered. Already-handled or read mail is skipped.

**Gmail API method used:** `users.messages.list`

### Step 2 — Subject filter (metadata only)

For each message ID, the app fetches **headers only** (no body) and checks the subject matches:

```text
<assessmentKey>-<description>
```

Examples: `srnVnEHFqfD3W7V3K4o3-B pharm`, `1EJWfNXPPbp5ByG3lSuc-assesment`  
`Re:` / `Fwd:` prefixes are stripped first.

Emails like `test not starting` or `Meeting tomorrow` are **skipped here** — no body download, no OpenAI.

**Gmail API method used:** `users.messages.get` (format: `metadata`)

### Step 3 — Load full message (Gmail API)

Only for subject matches, the app downloads the full body (plain text or HTML converted to text).

**Gmail API method used:** `users.messages.get` (format: `full`)

### Step 4 — Skip duplicates in the same poll

If two messages belong to the same **thread**, only one is processed per poll.

If the message already has the **`Auto-Replied`** label, it is skipped.

### Step 5 — Parse “Product Support Request”

The body must contain the Otomeyt template, for example:

```text
Product Support Request
Candidate Full Name: ...
Candidate Email ID: ...
Issue: not able to start the test
```

The parser supports:

- Blank lines between fields  
- Markdown-style bold labels (`*Candidate Email ID:*`)  
- Issue text on the line after `Issue:`

If the email is **not** this format (normal email, meeting invite, reply thread without the template at the top), it is **skipped** — no AI call for reply.

### Step 6 — Classify: is this a “cannot start” issue?

Two layers reduce wrong replies:

| Layer | What it does |
|-------|----------------|
| **A. Keyword / rules (local)** | Looks for phrases like “not able to start”, “camera not allowed”, “start button not working”. Rejects mid-assessment phrases (“during the test”, “reattempt”, “section failed”). |
| **B. OpenAI (cloud)** | Sends subject + issue text to the model with a strict prompt: answer **YES** only for cannot-start / permission / start-button problems; otherwise **NO**. |

Both must pass before a reply is sent. If OpenAI is unavailable or says NO, **no reply** is sent.

**OpenAI API used:** `POST /v1/chat/completions` (model: `gpt-4o-mini` by default, temperature 0 for classification)

### Step 7 — Generate reply content (OpenAI)

If approved, OpenAI generates a **formal HTML** email:

- Greets the candidate by name from the support request  
- Addresses their specific issue (camera, start button, etc.)  
- Includes standard troubleshooting steps (Chrome permissions, reload, incognito, different device)  
- Signs off as **Candidate Support Team**

If generation fails, a **static HTML template** is used as fallback.

**OpenAI API used:** `POST /v1/chat/completions` (temperature 0.3 for reply)

### Step 8 — Send email (Gmail API)

The app sends a reply:

| Field | Value |
|-------|--------|
| **From** | `Samiksha <samiksha.t@otomeyt.ai>` (configurable) |
| **To** | Candidate email from `Candidate Email ID` in the request |
| **Subject** | `Re: <original subject>` |
| **Body** | HTML + plain-text alternative (multipart) |
| **Threading** | Same Gmail thread (`In-Reply-To` / `References` headers) |

**Gmail API method used:** `users.messages.send` (raw MIME, base64url-encoded)

### Step 9 — Mark as handled (Gmail API)

After a **successful** send:

1. Add label **`Auto-Replied`** to the entire thread.  
2. Remove **`UNREAD`** (mark as read).

If labeling fails, the app still tries to **mark read** so the message does not keep appearing in `is:unread` searches.

**Gmail API method used:** `users.threads.modify`

### Step 10 — Dry-run mode (testing)

When `DRY_RUN=true` in `.env`:

- Steps 1–6 run as normal (including OpenAI).  
- Step 7 **does not send** — only logs `[DRY_RUN] Would send reply`.  
- Step 8 **does not** label or mark read — the same unread email may appear on every poll until marked manually or dry-run is turned off.

---

## 5. APIs and external services

### 5.1 Google Gmail API

| Purpose | API | OAuth scope |
|---------|-----|-------------|
| List/search messages | Gmail API v1 — `users.messages.list` | `gmail.modify` |
| Read message | `users.messages.get` | `gmail.modify` |
| Send reply | `users.messages.send` | `gmail.send` |
| Create/use label | `users.labels.list`, `users.labels.create` | `gmail.modify` |
| Label thread + mark read | `users.threads.modify` | `gmail.modify` |

**Authentication:** OAuth 2.0 (Desktop client).  
**Console setup:** Google Cloud project → enable **Gmail API** → OAuth consent screen → OAuth client → download `credentials.json`.  
**User sign-in:** One-time browser login as `samiksha.t@otomeyt.ai`; tokens stored in `token.json` (refresh token used for later runs).

Official docs: [Gmail API overview](https://developers.google.com/gmail/api/guides)

### 5.2 OpenAI API

| Purpose | Endpoint | Model (default) |
|---------|----------|-----------------|
| Confirm “cannot start” issue | Chat Completions | `gpt-4o-mini` |
| Generate HTML reply body | Chat Completions | `gpt-4o-mini` |

**Authentication:** API key in `.env` (`OPENAI_API_KEY`).  
**Data sent:** Email subject and issue text (no full mailbox).  
**Cost:** Per token per request (two calls per matched ticket).

Official docs: [OpenAI API reference](https://platform.openai.com/docs/api-reference)

### 5.3 No other third-party APIs

The app does **not** call Otomeyt internal APIs, webhooks, or databases. It only reads/writes via **Gmail** and uses **OpenAI** for classification and wording.

---

## 6. Technology stack

| Component | Technology | Role |
|-----------|------------|------|
| Language | **Node.js** | Runtime |
| Gmail client | **googleapis** (npm) | Gmail API wrapper |
| AI | **openai** (npm) | OpenAI SDK |
| Configuration | **dotenv** | Read `.env` file |
| Auth helper | **google-auth-library** (via googleapis) | OAuth tokens |

---

## 7. Configuration (`.env`)

| Variable | Purpose | Example |
|----------|---------|---------|
| `GMAIL_QUERY` | Base inbox search | `in:inbox` |
| `REPLY_FROM_EMAIL` | Sender address | `samiksha.t@otomeyt.ai` |
| `REPLY_FROM_NAME` | Display name | `Samiksha` |
| `PROCESSED_LABEL` | Label after reply | `Auto-Replied` |
| `DRY_RUN` | `true` = log only, no send | `true` / `false` |
| `POLL_INTERVAL_MS` | Milliseconds between polls | `30000` |
| `OPENAI_API_KEY` | OpenAI authentication | (secret) |
| `OPENAI_MODEL` | Model name | `gpt-4o-mini` |

**Files on disk (not in git):**

| File | Purpose |
|------|---------|
| `credentials.json` | Google OAuth client ID/secret |
| `token.json` | Refresh/access token for Samiksha’s mailbox |
| `.env` | Secrets and settings |

---

## 8. What gets a reply vs what does not

### Will auto-reply (when live)

- Unread **Product Support Request** in Samiksha’s inbox  
- Issue clearly about **cannot start** / permissions / start button  
- OpenAI confirms **YES**  
- Valid **Candidate Email ID** in the body  

### Will not auto-reply

| Example | Reason |
|---------|--------|
| Team meetings, newsletters, HR mail | Not Product Support Request format |
| Plain “test not start” test emails | Missing PSR template |
| Mid-test / section failed / reattempt | Rules + OpenAI reject |
| Pricing or general questions | Not a start issue |
| Already labeled `Auto-Replied` or read | Already handled |
| `DRY_RUN=true` | Test mode — log only |

---

## 9. Safety and compliance notes

1. **Narrow scope** — Only assessment-**start** issues; not a general auto-responder.  
2. **Human-readable logs** — Each decision logged (skip reason or match).  
3. **No double reply** — Label + read after successful send.  
4. **Test mode** — `DRY_RUN=true` for validation without sending.  
5. **OAuth** — App only accesses the mailbox that was authorized (Samiksha’s).  
6. **OpenAI** — Issue text sent to OpenAI; review Otomeyt data policy for third-party AI.  
7. **Google OAuth** — External/testing mode has user limits until app is Internal or verified for production.

---

## 10. How to run (operations)

```bash
cd gmail-auto-reply
npm install
npm start          # continuous polling
npm run run-once   # single poll (debug)
npm test           # automated safety tests (no Gmail send)
```

**First-time setup:** Place `credentials.json`, configure `.env`, run `npm start`, complete browser OAuth as `samiksha.t@otomeyt.ai`.

**Production recommendation:** Run under **systemd** or **PM2** so the process restarts after reboot; use **Internal** Google OAuth or complete app verification for org-wide use.

---

## 11. Code structure (for technical readers)

| File / folder | Responsibility |
|---------------|----------------|
| `src/index.js` | Main loop: poll → process messages |
| `src/auth.js` | Google OAuth login and token storage |
| `src/gmailClient.js` | Gmail search, read, send, labels |
| `src/supportRequest.js` | Parse Product Support Request body |
| `src/issueGate.js` | Rules + OpenAI YES/NO classification |
| `src/openaiReply.js` | Generate HTML reply |
| `src/responder.js` | Build MIME and send via Gmail |
| `src/finalizeThread.js` | Label + mark read after send |
| `src/pollQuery.js` | Search query and skip rules |
| `templates/assessmentNotStarting.js` | Fallback reply template |

---

## 12. Known limitations

- Runs as a **single process** — if it stops, polling stops until restarted.  
- **`after:<date>`** filter — only considers mail from the **calendar day the app started** (plus unread/label rules).  
- **Requires OpenAI** for approval — if the key fails, no auto-reply.  
- **Template changes** — If Otomeyt changes email format drastically, parser may need updates.  
- **Reply threads** — Emails that only quote the PSR at the bottom of a long thread may not parse.  
- **OAuth testing mode** — External + test users until Google app is production-ready.

---

## 13. One-page flow (for presentations)

```text
Unread PSR email in samiksha.t inbox
        ↓
Parse candidate name, email, issue
        ↓
Rules: start-issue keywords?  →  No → Skip
        ↓ Yes
OpenAI: cannot-start only?    →  No → Skip
        ↓ Yes
OpenAI: draft HTML reply
        ↓
Gmail: send To candidate, From samiksha.t@otomeyt.ai
        ↓
Gmail: label Auto-Replied + mark read
        ↓
Done (won't process again)
```

---

*Document version: June 2026 — matches gmail-auto-reply codebase.*
