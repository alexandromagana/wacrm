# Automations cron

`GET /api/automations/cron` drains the `automation_pending_executions` queue —
it's what fires a `wait` step once its timer is up (the 48h/5-day quote
follow-ups, the 1-day "pedir recibo" delay, etc.). Nothing inside this app
calls it; it only runs when something external pings it.

Auth: the request must carry an `x-cron-secret` header matching the
`AUTOMATION_CRON_SECRET` env var. Without a match, the endpoint 401s.

## Current setup (confirmed 2026-08-24)

- Scheduler: [cron-job.org](https://console.cron-job.org), job **"wacrm automation drain"**
- URL: `https://gamaenergia-wacm.ghewgb.easypanel.host/api/automations/cron`
- Schedule: every 5 minutes
- "Save responses in job history": off — turn this on if the job ever needs debugging, since the dashboard otherwise only shows pass/fail, not the response body.

## Known gap

`GET /api/flows/cron` (the Flows stale-run sweep, migration `010_flows.sql`)
has no scheduled job of its own on cron-job.org today. Harmless while the
`flows` / `flow_nodes` tables are empty, but it needs its own entry — same
account, same `AUTOMATION_CRON_SECRET` header — before Flows goes live.

## If a wait-step delay stops firing

1. cron-job.org → **wacrm automation drain** → check "Last Events" for failures.
2. A 401/403 there means `AUTOMATION_CRON_SECRET` on the EasyPanel deploy and
   the header configured on cron-job.org have drifted apart.
3. A 200 with nothing happening downstream means the queue itself is empty or
   the automation that queued the row got deactivated (`resumePendingExecution`
   cancels the row rather than sending in that case — see
   `src/lib/automations/engine.ts`).
