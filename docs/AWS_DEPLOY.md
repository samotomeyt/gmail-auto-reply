# Deploy on AWS (serverless — Lambda + EventBridge)

Region used in scripts: **Asia Pacific (Mumbai) `ap-south-1`**.

Use this guide to deploy into a **new AWS account** (company account). All resources below are created in whichever account your AWS CLI credentials target — nothing is shared with other accounts unless you deploy there separately.

## Architecture

```text
EventBridge (every 5 min) → Lambda → Gmail + OpenAI
                              ↑
                    Secrets Manager (OAuth + .env)
                              ↓
                    DynamoDB (audit: gmail-auto-reply-audit)
```

- **One Lambda invocation = one inbox poll** (same logic as local `npm start`, one cycle).
- **Reserved concurrency = 1** so two runs never reply twice to the same email.
- OAuth is done **once on a laptop**; `token.json` is stored in Secrets Manager.
- **DynamoDB**, Lambda, IAM, EventBridge, Secrets Manager, and auto-stop resources are all provisioned by the deploy scripts in the target account.

## Get the code

From Git (recommended):

```bash
git clone https://github.com/samotomeyt/gmail-auto-reply.git
cd gmail-auto-reply
npm install
```

Or use a zip/copy of the repo — same steps after `cd gmail-auto-reply`.

## Required local files (not in Git)

Place these in the project root before `npm run aws:setup-secrets`. They are listed in `.gitignore` and must **not** be committed.

| File | Purpose |
|------|---------|
| `credentials.json` | Google OAuth client (`client_id`, `client_secret`, redirect URIs) from Google Cloud Console |
| `token.json` | OAuth tokens for the Gmail mailbox (`access_token`, `refresh_token`, scopes) — created after local OAuth |
| `.env` | Runtime config (query, reply addresses, `DRY_RUN`, `OPENAI_API_KEY`, etc.) |

### `credentials.json`

Google Cloud OAuth **application** credentials (Desktop or Web client). Used to identify the app to Google APIs.

### `token.json`

OAuth **user** tokens for the mailbox that will poll/send (e.g. `samiksha.t@otomeyt.ai`). If the mailbox changes, re-run OAuth locally and replace this file, then re-run `aws:setup-secrets`.

### `.env` (example — copy from `.env.example`)

```bash
GMAIL_QUERY=in:inbox from:hello@otomeyt.ai to:candidatesupport@otomeyt.ai
REPLY_FROM_EMAIL=candidatesupport@otomeyt.ai
REPLY_FROM_NAME=Candidate Support
REPLY_CC=candidatesupport@otomeyt.ai,hello@otomeyt.ai
PROCESSED_LABEL=Auto-Replied
DRY_RUN=true
POLL_INTERVAL_MS=300000
OPENAI_API_KEY=<your-key>
OPENAI_MODEL=gpt-4o-mini
```

Optional: `AUDIT_ENABLED`, `AUDIT_TABLE_NAME`, `MONITOR_WEBHOOK_URL` (see `.env.example`).

`npm run aws:setup-secrets` bundles all three into one Secrets Manager JSON: `{ credentials, token, env }`.

## Prerequisites

1. **AWS CLI** installed.
2. **Node.js + npm** installed.
3. **AWS profile** for the target (company) account with permissions for:
   - Lambda (create/update/invoke)
   - IAM (create role, attach policies)
   - EventBridge (rules, targets)
   - Secrets Manager (create/update secret)
   - DynamoDB (create table)
   - CloudWatch Logs
   - SNS + CloudWatch Alarms (for auto-stop deploy)
4. Local files: `credentials.json`, `token.json`, `.env` (start with `DRY_RUN=true`).
5. **Gmail (before production):** “Send mail as” for `candidatesupport@otomeyt.ai` on the OAuth mailbox, or Gmail may rewrite the From address.

## Deploy to a new / company AWS account

### 1) Configure AWS CLI profile (one-time)

```bash
aws configure --profile company-prod
# Access Key ID, Secret Access Key, default region: ap-south-1, output: json
```

SSO alternative:

```bash
aws configure sso --profile company-prod
aws sso login --profile company-prod
```

### 2) Use that account for every command

```bash
export AWS_PROFILE=company-prod
export AWS_REGION=ap-south-1

aws sts get-caller-identity
```

Confirm the `Account` field is the **intended company AWS account ID**.

### 3) Clone, add secret files, install

```bash
git clone https://github.com/samotomeyt/gmail-auto-reply.git
cd gmail-auto-reply
# Place credentials.json, token.json, .env in this directory

npm install
```

### 4) Upload secrets (new account)

```bash
npm run aws:setup-secrets
```

Creates or updates secret: `gmail-auto-reply/app`.

### 5) Deploy Lambda + DynamoDB + schedule

```bash
npm run aws:deploy
```

Creates/updates in **this account only**:

| Resource | Name |
|----------|------|
| Secrets Manager | `gmail-auto-reply/app` (from step 4) |
| DynamoDB table | `gmail-auto-reply-audit` |
| IAM role | `gmail-auto-reply-lambda-role` |
| Lambda | `gmail-auto-reply` (Node 20, 512 MB, 10 min timeout) |
| EventBridge rule | `gmail-auto-reply-schedule` (`rate(5 minutes)`, **ENABLED** by deploy) |
| Reserved concurrency | `1` (if account limit allows) |

### 6) Deploy auto-stop guardrail (recommended)

```bash
npm run aws:deploy-autostop
```

Creates:

- Lambda `gmail-auto-reply-autostop`
- SNS topic `gmail-auto-reply-incident-topic`
- CloudWatch alarms (Lambda errors, send failures, finalize failures)

On alarm: disables `gmail-auto-reply-schedule` and sets `DRY_RUN=true` in the secret (default).

### 7) Disable schedule until verified (recommended)

`aws:deploy` enables the schedule immediately. For a safe rollout:

```bash
aws events disable-rule \
  --region ap-south-1 \
  --name gmail-auto-reply-schedule
```

### 8) Manual test

```bash
npm run aws:invoke
```

Watch logs:

```bash
aws logs tail /aws/lambda/gmail-auto-reply --region ap-south-1 --since 10m
# or --follow
```

### 9) Go live (after Gmail send-as + successful test)

1. Set `DRY_RUN=false` in `.env`.
2. Re-upload secrets and test again:

```bash
npm run aws:setup-secrets
npm run aws:invoke
```

3. Enable the schedule:

```bash
aws events enable-rule \
  --region ap-south-1 \
  --name gmail-auto-reply-schedule
```

## One-shot command block (handoff)

Replace `company-prod` with your profile name.

```bash
export AWS_PROFILE=company-prod
export AWS_REGION=ap-south-1
aws sts get-caller-identity

git clone https://github.com/samotomeyt/gmail-auto-reply.git
cd gmail-auto-reply
# Place credentials.json, token.json, .env here (DRY_RUN=true initially)

npm install
npm run aws:setup-secrets
npm run aws:deploy
npm run aws:deploy-autostop
aws events disable-rule --region ap-south-1 --name gmail-auto-reply-schedule
npm run aws:invoke
aws logs tail /aws/lambda/gmail-auto-reply --region ap-south-1 --since 10m
```

Go live later:

```bash
# DRY_RUN=false in .env
npm run aws:setup-secrets
npm run aws:invoke
aws events enable-rule --region ap-south-1 --name gmail-auto-reply-schedule
```

## Update after code changes

```bash
export AWS_PROFILE=company-prod
export AWS_REGION=ap-south-1

cd gmail-auto-reply
git pull
npm run aws:deploy
```

If `.env`, `token.json`, or `credentials.json` changed:

```bash
npm run aws:setup-secrets
```

## Deploy script environment variables

| Variable | Default |
|----------|---------|
| `AWS_REGION` | `ap-south-1` |
| `AWS_PROFILE` | (none — use `export AWS_PROFILE=...`) |
| `LAMBDA_FUNCTION_NAME` | `gmail-auto-reply` |
| `APP_SECRET_NAME` | `gmail-auto-reply/app` |
| `AUDIT_TABLE_NAME` | `gmail-auto-reply-audit` |
| `POLL_SCHEDULE` | `rate(5 minutes)` |
| `LAMBDA_MEMORY` | `512` |
| `LAMBDA_TIMEOUT` | `600` |

## Costs (rough)

- Lambda: ~288 invocations/day if schedule runs every 5 minutes (often empty polls).
- Secrets Manager: ~$0.40/month per secret after free trial.
- DynamoDB on-demand: low for audit volume.
- OpenAI: dominates cost per reply sent.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `invalid_grant` / OAuth | Re-run OAuth locally, update secret: `npm run aws:setup-secrets` |
| Wrong AWS account | Check `aws sts get-caller-identity` and `AWS_PROFILE` |
| `Run first: npm run aws:setup-secrets` | Secret missing in this account — run setup-secrets |
| No emails processed | Query uses `after:<today>` UTC; unread + no `Auto-Replied` label |
| From address wrong | Add/verify Gmail “Send mail as” for `REPLY_FROM_EMAIL` |
| Duplicate replies | One schedule only; reserved concurrency = 1 |
| Timeout | `LAMBDA_TIMEOUT=600` or reduce batch |

## Security

- Never commit `credentials.json`, `token.json`, or `.env`.
- Share those three files only over company-approved secure channels.
- Rotate `OPENAI_API_KEY` in `.env` and re-run `npm run aws:setup-secrets`.
- Revoke Google access at [Google Account permissions](https://myaccount.google.com/permissions) if `token.json` is exposed.

## Handoff checklist (owner → deployer)

- [ ] GitHub collaborator access to the repo
- [ ] `credentials.json`, `token.json`, `.env` sent securely
- [ ] `.env` has `DRY_RUN=true` for first deploy
- [ ] Deployer has `AWS_PROFILE` for company account
- [ ] `aws sts get-caller-identity` verified
- [ ] Schedule disabled until test pass
- [ ] Gmail “Send mail as” for `candidatesupport@otomeyt.ai` (production)
