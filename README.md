# AgentFlow

A multi-tenant workflow engine for chaining AI agent steps — a small n8n built for
agents. Workflows belong to organizations, start four different ways, and every
read and every action is checked against two independent permission layers.

Built on **nhost** (PostgreSQL + Hasura + Auth), **Hasura GraphQL Engine**
(queries, mutations, subscriptions, Actions, Event Triggers, Cron Triggers), and
**Next.js**.

- **Live app:** **https://agentflow-beta-jet.vercel.app**
- **Recording of the Final Task:** [`recordings/agentflow-final-task.mp4`](recordings/agentflow-final-task.mp4)
- **Design write-up:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Sign in with any account in the table below** — password `Password123!`

---

## What's here

| Piece | Where |
| --- | --- |
| Schema, functions, aggregation view | [`hasura/migrations/default/`](hasura/migrations/default) |
| Tracking, relationships, both permission layers | [`hasura/metadata/databases/default/tables/`](hasura/metadata/databases/default/tables) |
| Actions (incl. inbound webhook) | [`hasura/metadata/actions.yaml`](hasura/metadata/actions.yaml), [`actions.graphql`](hasura/metadata/actions.graphql) |
| Cron trigger | [`hasura/metadata/cron_triggers.yaml`](hasura/metadata/cron_triggers.yaml) |
| Event triggers | inside `public_notifications.yaml`, `public_watched_records.yaml` |
| Workflow executor | [`functions/_lib/executor.ts`](functions/_lib/executor.ts) |
| Step implementations | [`functions/_lib/steps/`](functions/_lib/steps) |
| Action / Event / Cron handlers | [`functions/`](functions) — nhost serverless functions |
| Shared backend code | [`functions/_lib/`](functions/_lib) (`_`-prefixed, so not routed) |
| Frontend | [`src/app/`](src/app), [`src/components/`](src/components) |
| Cross-org isolation test suite | [`scripts/verify-isolation.mjs`](scripts/verify-isolation.mjs) |

### Step types

`llm_call` · `http_request` · `db_write` · `notify` · `conditional_branch` · `approval_gate`

### Trigger types

`manual` (Run button) · `webhook` (Hasura Action, unauthenticated, token-addressed) ·
`scheduled` (Hasura Cron Trigger → per-workflow cron expressions) ·
`database_event` (Hasura Event Trigger on `watched_records`)

---

## Running it locally

### 1. Backend

Create a free project at [app.nhost.io](https://app.nhost.io). From the dashboard
you need the **subdomain**, **region**, and **admin secret**.

```bash
cp .env.example .env.local
# fill in subdomain, region, admin secret, and a GROQ_API_KEY
```

Get a free LLM key at [console.groq.com/keys](https://console.groq.com/keys). If you
leave `GROQ_API_KEY` blank the `llm_call` step falls back to a stub with a
disclosed ~900ms delay, and every stubbed output carries `stubbed: true` so it is
never mistaken for a real completion.

Apply schema and metadata:

```bash
npm install
npm i -g hasura-cli
npm run hasura:apply
```

### 2. Demo data

```bash
npm run seed
```

Creates two organizations with their own users, an `Incident triage` workflow in
Org A that exercises all six step types (llm_call → conditional_branch →
http_request → approval_gate → db_write → notify) with webhook and
database-event triggers, an editor-runnable workflow with a cron
trigger, and a separate Org B workflow.

| Account | Org | Role |
| --- | --- | --- |
| `owner-a@agentflow.test` | Acme Robotics (A) | owner |
| `editor-a@agentflow.test` | Acme Robotics (A) | editor |
| `viewer-a@agentflow.test` | Acme Robotics (A) | viewer |
| `owner-b@agentflow.test` | Northwind Labs (B) | owner |

Password for all four: `Password123!`

### 3. App

```bash
npm run dev
```

> **One caveat about local development.** The Action, Event and Cron handlers are
> nhost serverless functions, deployed to your nhost project rather than served by
> `next dev`. Queries, mutations, subscriptions and every row permission work
> against the cloud backend from a local frontend; anything that goes *through* a
> Hasura Action runs on the deployed functions. Use `nhost up` if you want the
> whole stack locally (requires Docker).

---

## Verifying it actually works

```bash
npm run verify
```

Signs in as all four demo users and drives the public GraphQL endpoint with their
real JWTs — no admin secret — asserting that cross-org reads return nothing, that
role scoping holds inside an org, that owner-only step types are refused for
editors, that a step cannot be escalated into a gated type by update, that
`step_runs` cannot be written directly to clear an approval gate, and that the
Actions refuse cross-org callers without revealing whether the target exists.

If sign-in starts failing — closed connections, empty responses, HTTP 429 —
that is nhost's brute-force protection, which counts sign-in attempts per IP over
a rolling few minutes. This suite spends four per run, so a few runs back to back
will trip it. Wait a few minutes; nothing is broken.

Start a run the way an external system would:

```bash
npm run demo:webhook
npm run demo:webhook -- "Coffee machine is out of beans"     # takes the other branch
```

---

## Deployment

Two pieces deploy to two places, which is what the stack asks for:

- **Backend handlers** — the four Actions, two Event Triggers and the Cron
  dispatcher live in [`functions/`](functions) and deploy to **nhost** when you
  push to a connected GitHub repository.
- **Frontend** — the Next.js app deploys to **Vercel**. It contains no API
  routes; it is a pure client of the GraphQL API.

### 1. Connect the repo to nhost

In the nhost dashboard, open your project → **Git** → connect this GitHub
repository, leaving the base folder as `/`. Pushing to the connected branch
deploys everything under `functions/`.

### 2. Add one project environment variable

nhost injects `NHOST_GRAPHQL_URL`, `NHOST_ADMIN_SECRET` and `NHOST_WEBHOOK_SECRET`
into every function, so the Hasura connection and the Hasura→function shared
secret need no setup at all. Only the LLM key has to be added under
**Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `GROQ_API_KEY` | your Groq key (omit to run the disclosed LLM stub) |

Optionally `SLACK_WEBHOOK_URL` to make `notify` deliver for real instead of
recording `simulated`.

### 3. Point Hasura at the functions

```bash
# in .env.local
ACTION_BASE_URL=https://<subdomain>.functions.<region>.nhost.run/v1
npm run hasura:apply
```

### 4. Deploy the frontend

Any Vercel import of this repo works. It needs exactly two environment
variables, `NEXT_PUBLIC_NHOST_SUBDOMAIN` and `NEXT_PUBLIC_NHOST_REGION`, and
**no secrets at all** — the admin secret and the LLM key live only in the nhost
functions runtime, and the browser talks to Hasura with the signed-in user's own
JWT. A leak of the frontend deployment's configuration would expose nothing.

### A note on `{{ACTION_BASE_URL}}`

Tracked metadata refers to the handler host as `{{ACTION_BASE_URL}}`, the
idiomatic Hasura way to keep an environment-specific URL out of version control.
Hasura resolves it from its own environment; on nhost that means a variable added
in the project dashboard. `scripts/hasura-apply.sh` substitutes it from your local
`.env.local` into a throwaway copy of the metadata instead, so a fresh clone works
without a dashboard visit — nothing environment-specific is written back into the
tracked files.

The shared secret needs no such handling. Metadata references
`value_from_env: NHOST_WEBHOOK_SECRET`, which nhost injects into both Hasura and
the functions runtime, so the two sides agree with nothing copied between them and
nothing to drift out of step.

## The recording

[`recordings/agentflow-final-task.mp4`](recordings/agentflow-final-task.mp4) — 85
seconds, no audio, two browsers side by side against the deployed app.

- **Left:** an Org A **owner**. **Right:** an Org A **editor**, then an Org B owner.
- The owner starts the run; it streams step by step and stops at the approval gate.
- The **editor** approves in the right-hand window, and the left-hand window
  resumes and finishes on its own — nothing is clicked in it.
- Finally the Org B owner pastes that exact run id and is refused, with both
  address bars showing the same id side by side.

Everything in it is real: a live Groq call, a real outbound HTTP request, a real
approval through the Action, and a real subscription driving the left window.

The same walkthrough can also be driven automatically, which is how it was
rehearsed before filming:

```bash
node scripts/record-demo.mjs   # drives the live app in two browsers, captures video
bash scripts/stitch-demo.sh    # side-by-side + isolation segment -> one MP4
```

---

## The final scenario, end to end

1. Sign in as **`owner-a@agentflow.test`** → open **Acme Robotics** → **Incident triage**.
   Six steps covering all six step types, including a branch and a gate.
2. Press **Run workflow**. The run page opens on a live `step_runs` subscription.
   `Classify alert` calls Groq for real; `Urgent?` reads its verdict; the run pauses
   at `Human approval` with the run marked **paused**. Nothing polls or refreshes.
3. In a second browser, sign in as **`editor-a@agentflow.test`**, open the same run,
   and approve. The first browser resumes on its own and finishes through `db_write`
   and `notify` — the latter inserting a `notifications` row that a Hasura Event
   Trigger then delivers.
4. Start the same workflow without a button: `npm run demo:webhook`, or use the
   **insert watched record** control on the workflow page to fire the database-event
   trigger. Both produce a new run in the history, live.
5. Sign in as **`viewer-a@agentflow.test`** — the Run button is gone and step
   editing is read-only. Calling `triggerWorkflowRun` directly is refused by the
   handler regardless, so hiding it is presentation rather than the control.
6. Sign in as **`owner-b@agentflow.test`** and paste any Org A id into the URL —
   `/org/<A>`, `/org/<A>/workflow/<A>`, `/run/<A>`. Each reports no access, because
   the row permission returned nothing. `npm run verify` asserts the same thing
   against the API directly.

---

## One design decision worth flagging

**`owner`/`editor`/`viewer` are not Hasura roles.** Role is per-org data, held in
`org_members` and checked inside the permission filter, and there is exactly one
authenticated Hasura role (`user`).

This is what the brief asks for — "every permission also has to scope to the
caller's own org via `org_members`" — taken literally. The alternative, three
Hasura roles carried in the JWT, breaks the moment one user holds different roles
in two orgs: an nhost JWT carries a single global `allowed-roles` set, so selecting
`editor` would grant editor rights in *every* org that user belongs to. It happens
to look correct in a two-org demo where nobody has dual membership, which is
exactly the kind of shortcut this build avoids.

Full reasoning, plus how the approval gate pauses and resumes, is in
[`docs/DESIGN.md`](docs/DESIGN.md).
