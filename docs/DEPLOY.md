# Deploying

Two routes. The free one is what the public demo runs on.

Whichever you pick, **secrets go into the platform's own secret store**, never into
a file in this repository and never into a chat window. `.env` is gitignored and
`.env.example` carries no real values.

---

## Why not Vercel or Netlify

Both are serverless, and this system has a process that must stay running.
`packages/worker` is a `node-cron` scheduler that claims queue batches with
`SELECT ... FOR UPDATE SKIP LOCKED` and holds a Postgres advisory lock for the
length of a run. The API process is *structurally forbidden* from scheduling —
`packages/api/src/no-scheduler.ts` arms a trap at import time and refuses to boot
if a timer has been registered — because three API replicas would fire every job
three times, and nothing would error.

Putting this on a serverless host means deleting the worker and rebuilding the
jobs as HTTP-triggered functions with an execution ceiling. That is a different
system with different failure modes, chosen to suit the host rather than the
problem. The free route below keeps the architecture intact instead.

---

## Free route — Neon + Render + GitHub Actions

Total cost zero. The worker runs as a scheduled GitHub Actions job invoking
`packages/worker --once`: the same jobs, in the same order, through the same
`runJob` and the same advisory lock. A different trigger, not a different code
path — sends still leave through `deliverClaimed`, still the only call site of
`provider.send` (I1).

The trade is latency. GitHub's shortest cron is five minutes and is best-effort
under load, so a message can wait a little longer than it would on a dedicated
worker. For a demo that is the right trade. For real delivery, run
`packages/worker` as a process and delete `.github/workflows/worker.yml`.

### 1. Database

Render's free Postgres is deleted after 30 days, which is no good for something
linked from a CV. Neon's free tier persists.

1. <https://neon.tech> → new project, Postgres 17 or later.
2. Copy the pooled connection string (`postgresql://...?sslmode=require`).

### 2. Schema and demo data

From your machine, once:

```bash
cd ~/projects/campaign-engine
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
export DATABASE_URL='<neon connection string>'

npm run migrate        # idempotent, advisory-locked, content-hash guarded
npm run seed:demo
npm run demo:simulate  # 30 days of plausible history
npm run rollups:rebuild
```

### 3. The web service

1. <https://dashboard.render.com> → **New → Web Service** → connect
   `vipinsao/Campaign_project` → branch `main` → runtime **Docker**.
2. Instance type **Free**.
3. Environment variables:

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | the Neon string |
   | `SEND_MODE` | `mock` |
   | `JWT_SECRET` | `openssl rand -base64 48` |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` |
   | `PUBLIC_BASE_URL` | *(step 5)* |

4. Deploy. Migrations run on boot, so a fresh database needs no extra step.
5. Copy the service URL, set `PUBLIC_BASE_URL` to it, and redeploy.

   **Do not skip this.** `PUBLIC_BASE_URL` builds every unsubscribe and tracking
   link. Wrong here and every opt-out link in every message resolves nowhere — the
   exact failure invariant I7 exists to catch, and one nobody notices internally
   because nobody internally ever clicks an unsubscribe link.

### 4. The worker

Repository → **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | the Neon string |
| `PUBLIC_BASE_URL` | the Render URL |

Three workflows then run on their own:

| Workflow | Schedule | What it does |
| --- | --- | --- |
| `worker.yml` | every 5 min | every job once: drain queue, triggers, reclaim, rollups |
| `demo-reset.yml` | 04:00 UTC | reseed, re-simulate, rebuild rollups |
| `keep-warm.yml` | every 10 min | `GET /healthz` so the free service does not sleep |

Trigger `worker` manually once from the Actions tab to confirm the secret works.

### 5. Check it

```bash
curl -fsS https://<your-service>.onrender.com/healthz
```

Then open the URL: `/shop` is the public storefront, the operator console loads at
`/campaigns`, `/mock-outbox` shows the messages the simulation sent, and `/inspect`
explains why anything that did not send did not send.

### 6. Sending for real

Everything above runs in `mock` mode and contacts nobody. To make `/shop` put an
actual email in a stranger's inbox — on free tiers, and with an honest account of
what is not achievable for free — follow
[`LIVE-SENDING.md`](LIVE-SENDING.md).

---

## Paid route — Render blueprint

`render.yaml` deploys the architecture as designed: API, worker and nightly cron
as separate services from one image, plus Postgres.

1. **New → Blueprint** → select the repository.
2. Set `PUBLIC_BASE_URL` on both services after the first deploy, then redeploy.

Roughly $7/month each for the worker and cron and $6 for Basic Postgres. Render's
free tier does not cover Background Workers or Cron Jobs.

---

## Send mode

`SEND_MODE` is the switch that decides whether anybody is actually contacted.

| Value | Behaviour |
| --- | --- |
| `off` | refuse to send, and refuse **before** claiming a queue row (I2). The default everywhere. |
| `mock` | write to the mock outbox and fire simulated receipts. What the demo runs. |
| `live` | call the real provider. |

The default is `off` in every environment on purpose: a fresh clone, a CI run and a
developer laptop must all decline to contact anybody. Turning on `live` is a
deliberate act, and `TRIGGER_FLOOR_AT` must be set with it — an unset floor makes
the time-trigger job enrol nobody, which is what stops a first deploy from mailing
four years of order history.
