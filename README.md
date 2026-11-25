# ed-client-worker

Internal **ÉcoleDirecte** API for the Lumaris account workers.

This worker owns the whole ÉcoleDirecte session — login, GTK/cookies, token
cache and the 2FA (QCM) relay — and exposes a small internal API that other
workers of the same Cloudflare account consume through a **service binding**.
It has **no public URL** (`workers_dev: false`): it is only reachable via
`env.ED_CLIENT.fetch(...)`.

## Consumers

| Worker | Binding | Usage |
|---|---|---|
| `main-client-worker` | `ED_CLIENT` | proxies `/api/ed/*` to the browser (workspace timetable, grades…) and calls `new-grades` from the `check_grades` cron workflow |

## API routes

All routes are subpaths of the request URL. Request/response bodies are JSON.

| Route | Method | Description |
|---|---|---|
| `/info` | GET | Student account info — also performs the login |
| `/grades` | GET | Grades (`filter: true` header = light payload) |
| `/averages` | GET | Grade averages |
| `/new-grades` | GET | Grades since last check (cron workflow) |
| `/homeworks` | GET | Homework list (`filter: true` = light) |
| `/homeworks` | POST | `{ id, done }` mark homework done/undone |
| `/timetable` | GET | Timetable (`filter: true` = 2-week day grid) |
| `/qcm` | POST | `{ choice }` answer the pending 2FA questionnaire |

### 2FA (QCM) flow

When ÉcoleDirecte answers login code `250`, **every** route returns:

```json
{ "qcm_required": true, "question": "…", "propositions": ["…", "…"] }
```

The caller must relay `question`/`propositions` to the end user, then POST the
chosen index to `/qcm`. On success the session is cached (~29 min) and the
original route can be retried.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `ED_USERNAME` | Worker secret/var | ÉcoleDirecte identifier |
| `ED_PASSWORD` | Worker secret/var | ÉcoleDirecte password |
| `USER_AGENT` | optional var | overrides the default `Lumaris-Dashboard/1.0` UA |

Set credentials on the deployed worker (never commit them):

```bash
wrangler secret put ED_USERNAME
wrangler secret put ED_PASSWORD
```

Bindings declared in other workers' `wrangler.jsonc` (resolved by
`update-client-account` at deploy time):

```jsonc
"services": [{ "binding": "ED_CLIENT", "service": "ed-client-worker" }]
```

## Layout

```
src/
  index.js                     # internal fetch router → EDfunction
  backend/
    ecole_directe/             # ED API clients (login, QCM, grades, homeworks, timetable)
    cache/                     # Cache-API helpers for the ED session/token
```

## Deployment

Deployed by `update-client-account` like every account worker: add an entry
for `ed-client-worker` → this repository in the updater `CONFIGURATION`, then
trigger `/api/update-workers`. Service bindings are inherited from
`wrangler.jsonc` `services` arrays, so `main-client-worker` must declare
`ED_CLIENT` **before** (or in the same run as) this worker exists.
