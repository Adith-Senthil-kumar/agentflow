# AgentFlow

A multi-tenant workflow engine for chaining AI agent steps — a small n8n built for
agents. Workflows belong to organizations, start four different ways, and every
read and every action is checked against two independent permission layers.

Built on **nhost** (PostgreSQL + Hasura + Auth), **Hasura GraphQL Engine**
(queries, mutations, subscriptions, Actions, Event Triggers, Cron Triggers), and
**Next.js**.

- **Live app:** _see the deployment section below_
- **Design write-up:** [`docs/DESIGN.md`](docs/DESIGN.md)

---

## What's here

| Piece | Where |
| --- | --- |
| Schema, functions, aggregation view | [`hasura/migrations/default/`](hasura/migrations/default) |
| Tracking, relationships, both permission layers | [`hasura/metadata/databases/default/tables/`](hasura/metadata/databases/default/tables) |
| Actions (incl. inbound webhook) | [`hasura/metadata/actions.yaml`](hasura/metadata/actions.yaml), [`actions.graphql`](hasura/metadata/actions.graphql) |
| Cron trigger | [`hasura/metadata/cron_triggers.yaml`](hasura/metadata/cron_triggers.yaml) |
| Event triggers | inside `public_notifications.yaml`, `public_watched_records.yaml` |
| Workflow executor | [`src/lib/executor.ts`](src/lib/executor.ts) |
| Step implementations | [`src/lib/steps/`](src/lib/steps) |
| Action / Event / Cron handlers | [`src/app/api/`](src/app/api) |
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
Org A (llm_call → conditional_branch → http_request → approval_gate → db_write)
with webhook and database-event triggers, an editor-runnable workflow with a cron
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

> **One caveat about local development.** Hasura runs in nhost's cloud, so it
> cannot call Action, Event, or Cron handlers on `http://localhost:3000`.
> Queries, mutations, subscriptions and every row permission work fine locally;
> anything that goes *through* a Hasura Action needs `ACTION_BASE_URL` to point at
> a publicly reachable origin. Either point it at the deployed app, or expose your
> dev server with a tunnel and re-run `npm run hasura:apply`.

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

Start a run the way an external system would:

```bash
npm run demo:webhook
npm run demo:webhook -- "Coffee machine is out of beans"     # takes the other branch
```

---

## Deployment

The app deploys as a single Next.js project; the Action, Event Trigger, and Cron
handlers are API routes in the same deployment, so there is one thing to deploy
and the executor sits next to the UI that watches it.

1. Deploy to Vercel and set these environment variables:

   `NEXT_PUBLIC_NHOST_SUBDOMAIN`, `NEXT_PUBLIC_NHOST_REGION`, `HASURA_GRAPHQL_URL`,
   `HASURA_GRAPHQL_ADMIN_SECRET`, `AGENTFLOW_WEBHOOK_SECRET`, `GROQ_API_KEY`,
   `GROQ_MODEL`, and `ACTION_BASE_URL` set to the deployment's own origin.

2. Point Hasura at the deployment:

   ```bash
   # in .env.local
   ACTION_BASE_URL=https://your-app.vercel.app
   npm run hasura:apply
   ```

### A note on `{{ACTION_BASE_URL}}`

Tracked metadata refers to the handler host as `{{ACTION_BASE_URL}}` and to the
shared secret as `value_from_env: AGENTFLOW_WEBHOOK_SECRET`, which is the
idiomatic Hasura way to keep environment-specific values out of version control.
Hasura normally resolves those from its own environment — on nhost, variables added
in the project dashboard.

`scripts/hasura-apply.sh` substitutes both from your local `.env.local` into a
throwaway copy of the metadata before applying, so a fresh clone works without a
dashboard visit. If you add the two variables to your nhost project instead, delete
the substitution block in that script and the tracked metadata applies unchanged.

---

## The final scenario, end to end

1. Sign in as **`owner-a@agentflow.test`** → open **Acme Robotics** → **Incident triage**.
   Five steps, three types, plus a branch and a gate.
2. Press **Run workflow**. The run page opens on a live `step_runs` subscription.
   `Classify alert` calls Groq for real; `Urgent?` reads its verdict; the run pauses
   at `Human approval` with the run marked **paused**. Nothing polls or refreshes.
3. In a second browser, sign in as **`editor-a@agentflow.test`**, open the same run,
   and approve. The first browser resumes on its own and finishes through `db_write`.
4. Start the same workflow without a button: `npm run demo:webhook`, or use the
   **insert watched record** control on the workflow page to fire the database-event
   trigger. Both produce a new run in the history, live.
5. Sign in as **`viewer-a@agentflow.test`** — the Run button is gone, and calling
   `triggerWorkflowRun` directly is refused by the handler.
6. Sign in as **`owner-b@agentflow.test`** and paste any Org A id into the URL —
   `/org/<A>`, `/org/<A>/workflow/<A>`, `/run/<A>`. Each reports no access, because
   the row permission returned nothing. `npm run verify` asserts the same thing
   against the API directly.

---

## Deliberate design decisions

Three choices worth flagging, because each departs from the most obvious reading
of the brief. All three are argued in full in [`docs/DESIGN.md`](docs/DESIGN.md).

- **`owner`/`editor`/`viewer` are not Hasura roles.** A user can hold different
  roles in different orgs, and an nhost JWT carries one global set of allowed
  roles. Role lives in `org_members` and is checked inside the permission filter.
- **Quota is reserved at admission, not incremented at completion.** Incrementing
  on completion lets N concurrent runs pass a check only one should have passed.
- **A workflow containing owner-only step types can only be *started* by an
  owner.** Configuring a privileged side effect and causing one are the same
  privilege; without this the insert gate would be decorative.
