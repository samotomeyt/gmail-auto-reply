# Deploy on AWS (serverless — Lambda + EventBridge)

Region used in scripts: **Asia Pacific (Mumbai) `ap-south-1`**.

## Architecture

```text
EventBridge (every 5 min) → Lambda → Gmail + OpenAI
                              ↑
                    Secrets Manager (OAuth + .env)
```

- **One Lambda invocation = one inbox poll** (same logic as local `npm start`, one cycle).
- **Reserved concurrency = 1** so two runs never reply twice to the same email.
- OAuth is done **once on your laptop**; `token.json` is stored in Secrets Manager.

## Prerequisites

1. AWS CLI installed and logged in (`aws configure`) — use **ap-south-1**.
2. Local project working: `credentials.json`, `token.json`, `.env` with `OPENAI_API_KEY`.
3. IAM user/role permissions: Lambda, IAM, EventBridge, Secrets Manager, CloudWatch Logs.

## Step 1 — Install dependencies

```bash
cd gmail-auto-reply
npm install
```

## Step 2 — Upload secrets (from your machine)

Uses your local `credentials.json`, `token.json`, and `.env`:

```bash
npm run aws:setup-secrets
```

Optional: set `DRY_RUN=false` in `.env` before this when you are ready for live sends.

## Step 3 — Deploy Lambda + schedule

```bash
npm run aws:deploy
```

This creates/updates:

- IAM role `gmail-auto-reply-lambda-role`
- Lambda `gmail-auto-reply` (Node 20, 512 MB, 10 min timeout)
- EventBridge rule every **5 minutes**
- Reserved concurrency **1**

## Step 4 — Test manually

```bash
npm run aws:invoke
```

Watch logs:

```bash
aws logs tail /aws/lambda/gmail-auto-reply --region ap-south-1 --follow
```

## Step 5 — Go live

1. Set `DRY_RUN=false` in `.env`.
2. Run `npm run aws:setup-secrets` again (updates secret).
3. Run `npm run aws:invoke` and confirm a real send in logs.
4. Schedule keeps running automatically.

## Auto-stop guardrail (recommended)

Deploy incident auto-stop wiring:

```bash
AWS_PROFILE=samiksha AWS_REGION=ap-south-1 npm run aws:deploy-autostop
```

This creates:

- `gmail-auto-reply-autostop` Lambda
- SNS topic for incident alarms
- CloudWatch alarms:
  - Lambda `Errors`
  - `SendFailedCount` (from log metric filter)
  - `FinalizeFailedCount` (from log metric filter)

When any alarm enters ALARM state, auto-stop Lambda:

1. Disables EventBridge rule `gmail-auto-reply-schedule`
2. Forces `DRY_RUN=true` in Secrets Manager (configurable)

## Update after code changes

```bash
npm run aws:deploy
```

## Costs (free tier)

- Lambda: usually within free tier for ~8k runs/month (5 min schedule).
- Secrets Manager: ~$0.40/month per secret after free trial.
- CloudWatch Logs: small volume is usually free.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `invalid_grant` / OAuth | Re-run OAuth locally, update secret: `npm run aws:setup-secrets` |
| No emails processed | Query uses `after:<today>` UTC; unread + no `Auto-Replied` label |
| Duplicate replies | Ensure only one schedule; concurrency is set to 1 |
| Timeout | Increase `LAMBDA_TIMEOUT=600` or reduce inbox batch |

## Environment variables (deploy script)

| Variable | Default |
|----------|---------|
| `AWS_REGION` | `ap-south-1` |
| `LAMBDA_FUNCTION_NAME` | `gmail-auto-reply` |
| `APP_SECRET_NAME` | `gmail-auto-reply/app` |
| `POLL_SCHEDULE` | `rate(5 minutes)` |

## Security

- Never commit `credentials.json`, `token.json`, or `.env`.
- Rotate `OPENAI_API_KEY` in `.env` and re-run `aws:setup-secrets`.
