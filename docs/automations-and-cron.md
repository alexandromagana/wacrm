# Automations cron

`GET /api/automations/cron` drains the `automation_pending_executions` queue —
it's what fires a `wait` step once its timer is up (the 48h/5-day quote
follow-ups, the 30-minute "pedir recibo" delay, etc.). Nothing inside this app
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

## Lifecycle sweep (piggybacks on the same job)

Every call to `/api/automations/cron` also offers the lifecycle sweep
(`src/lib/lifecycle/`) a turn, after the response is sent. It closes
prospects who went silent, sends leads who never sent their CFE bill one
reminder, and flags chats a person owns as "To close" instead of touching
them. The rules are in `rules.ts`, the timings in `config.ts`:

- **Quoted**: closed once silent 8 days after the quote (or their last
  message) and 3 days after the last follow-up — i.e. 3 days after the
  `sin_respuesta` follow-up. Lost reason `auto_sin_respuesta_seguimientos`.
- **Never sent the bill**: after 3 quiet days, one `gama_seguimiento_lead`
  reminder (business hours only, 9–19 Mexico City, Mon–Sat); closed 4 days
  later with `auto_sin_recibo`. Silent over 45 days with no reminder: closed
  directly, no message.
- **Never wrote**: closed 4 days after the reminder template reached them
  (`auto_sin_contacto`).
- **Left alone**: chats assigned to a person (suggested instead), contacts
  tagged `No cerrar`, won deals, stages with *Auto-close inactive* off
  (pipeline settings), and contacts with an automation still waiting.

A closed chat reopens by itself when the customer writes (DB trigger,
migration 052), and a deal the sweep lost reopens with it.

**Switch**: the `LIFECYCLE_SWEEP` env var on the EasyPanel deploy —
`off` (default, also when unset), `dry_run` (decides and logs, changes
nothing), `apply`. It runs at most once every 30 minutes (the unique
`lifecycle_runs.slot`), sends at most 15 reminders and closes at most 50
chats per run. To pause it, set `off` and redeploy.

**What it did**: `lifecycle_runs` (one row per run, with a summary) and
`lifecycle_actions` (one row per chat it acted on, with the outcome and
any send error). For example:

```sql
select a.created_at, a.action, a.reason, a.outcome, a.detail, c.name
from lifecycle_actions a left join contacts c on c.id = a.contact_id
order by a.created_at desc limit 50;
```

**Before switching it on**, review the backlog:
`npx tsx scripts/lifecycle-backlog.ts` lists what it would do right now
(CSV in the temp folder), and `--exempt=<file>` tags the chats to keep
open with `No cerrar`.
