# Alerting

Every part is optional and does nothing until its secret is set. Nothing here reaches a person until the setup below is done.

| Signal | Where it goes |
| --- | --- |
| Unexpected server failures, including dead-lettered dispatches | PostHog error tracking, through `logFailure` |
| Browser errors and product analytics | PostHog, through the `/ingest` rewrite |
| Pipeline health, hourly | Healthchecks.io heartbeat |
| API and web uptime | Not monitored yet: see Later |

## Alerts

The hourly check lives in `packages/services/src/operational-health.ts`, which holds the thresholds.

| Alert | Severity | Fires when |
| --- | --- | --- |
| `dispatch_dead_lettered` | Critical | Any dispatch dead-lettered in the last 2 hours |
| `dispatch_undelivered` | Critical | A current-epoch dispatch waits over 75 minutes for delivery. The limit is longer than the cron because the hourly reconcile redelivers a failed dispatch. |
| `render_queue_stuck` | Critical | A current-epoch render in an active Workspace waits over 60 minutes for a slot. Shorter waits are normal for lower tiers on a busy day. |
| `render_failures` | Warning | At least 3 failures and 20% of the last hour's renders |
| `attempts_expired` | Warning | At least 3 attempts expired in the last hour |

Critical alerts send a failure signal to Healthchecks.io and open a PostHog issue. Warnings open a PostHog issue only. A missed heartbeat means the Worker cron, maintenance or the database did not run.

**Planned fences look like an outage.** While `ADMISSION_STATE` is `fenced` the cron stops before the check, so no heartbeat arrives and Healthchecks.io reports the check down after 1 hour 15 minutes. Pause the check in Healthchecks.io for the length of a cutover.

The check runs inside the hourly cron on purpose. On Neon Free a tighter schedule would keep the database awake and exhaust its compute allowance. Move it to every 5 minutes after moving to Neon Scale.

### Publishing alerts

Two PostHog insight alerts email the owner. They are set in PostHog, not in code.

| Alert | Insight | Fires when |
| --- | --- | --- |
| `Publishing failures` | `Publishing failures by reason` | Any `error_code` has a failure in the hour |
| `Publish delay over 5 minutes` | `Publish delay p95 by platform` | Any platform's p95 `publish_delay_sec` passes 300 |

Both run at minute 15 with an evaluation delay of one completed hour. The forwarder sends events up to an hour late and PostHog never re-reads a checked hour, so without the delay a failure in an hour's last two minutes would not alert. A failure alerts 1¼ to 2¼ hours after it happens, and PostHog's first check ran 30 minutes after its planned time, so allow up to 3 hours. Use the alerts for trends and the post list for what is failing now.

## Setup

1. **PostHog:** create a US Cloud project.
   - Set `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` in Vercel and redeploy web.
   - Run `bunx wrangler secret put POSTHOG_PROJECT_TOKEN` from `apps/api`. Use the same value.
   - In Error tracking, add an alert for new and reopened issues, sent to email or Slack.
2. **Healthchecks.io:** create a check with a 1-hour period and a 15-minute grace period. It emails on failure.
   - Run `bunx wrangler secret put HEARTBEAT_URL` from `apps/api`, using the check's ping URL. The URL is a secret.

The rewrites assume PostHog US Cloud. An EU project needs the `eu` hosts in `apps/web/next.config.ts`, `apps/web/instrumentation-client.ts` and `apps/api/src/failure-reporter-runtime.ts`.

## Before launch

- Add the consent the launch markets require. Analytics runs by default today.
- Review session replay masking before enabling it. It is off, and PostHog does not mask page text by default.
- Modal executors do not report to PostHog. A failed render reaches Postgres, and these alerts see it. A crash that never reports back appears once its deadline passes.

## What leaves the product

- **Worker errors:** the failure label, error name, code, redacted stack frames and an allowlist of context. The error's own message stays in the Worker log; the event's `requestId` finds that line.
- **Browser:** the `/ingest` proxy strips cookies, so Clerk's session never reaches PostHog. URL properties lose query strings and tokens. Review, share and invite pages do not load analytics at all.

## Later: uptime monitors

The hourly heartbeat cannot see a short outage between runs. Add monitors for `/api/ready` and the web origin with UptimeRobot: its free plan allows commercial use, with 50 monitors at a 5-minute interval. Its free plan has no heartbeat monitoring, so Healthchecks.io stays.

## Later: phone alerts with PagerDuty

Deferred on 2026-11-05, because PagerDuty sign-up needs a business email. Until then alerts reach email and Slack only, so nothing can wake someone.

When a business email exists:

1. Create a PagerDuty service with the Events API v2 integration.
2. Point the PostHog issue alert's HTTP webhook and a Healthchecks.io integration at it. PagerDuty receives events at `https://events.pagerduty.com/v2/enqueue`.
3. Page only on Critical alerts and a missed heartbeat. Leave warnings on email.
