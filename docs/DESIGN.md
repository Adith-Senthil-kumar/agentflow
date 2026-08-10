# AgentFlow — design notes

## Schema reasoning

The spine is `organizations → org_members → workflows → {workflow_steps, workflow_triggers}`
and `workflows → workflow_runs → step_runs`. Two things about it are load-bearing.

**`org_members` is the only membership fact in the system.** Every permission rule
in the app resolves through it. Nothing is scoped by a client-supplied header or a
claim baked into a token — a permission filter always walks the relationship graph
back to a row that says "this user is in this org with this role". That single
choice is what makes cross-org isolation airtight rather than merely present:
there is no second path to authority that could disagree with the first.

**Definitions and executions are separate tables.** `workflow_steps` is the plan;
`step_runs` is what happened. They are joined by a nullable `step_id`, so editing a
workflow never rewrites history and deleting a step leaves finished runs readable.
`step_runs` carries its own `type` and `name` copies for that reason. It is also the
subscription target, which is why the executor writes to it after every state
change rather than batching at the end — the live feed is a side effect of honest
bookkeeping, not a separate reporting path.

Step and trigger types are text columns with FKs to lookup tables rather than
native `enum` types. That is not just about avoiding `ALTER TYPE` locks: a lookup
row can carry attributes, and `step_types.owner_only` is read directly by a Hasura
permission rule. The list of privileged step types therefore lives in exactly one
place, and the UI, the row permission and the Action handler all read the same
column.

`workflow_runs.org_id` is denormalised from `workflows` for quota aggregation, and
a database trigger rejects any row where it disagrees with the workflow's real org.
Permission rules deliberately ignore that column and traverse the relationship
instead, so isolation never depends on the denormalisation being correct.

The required aggregation is a view, `org_usage_current_month` — quota position, run
counts by status, steps executed, and average run duration for the calendar month —
tracked with its own org-scoped select permission through a manual relationship back
to `organizations`.

## Two permission layers, enforced differently

**Layer 1 — org + role scoping — is Hasura row permissions.** Every rule combines
both concerns in one boolean expression:

```yaml
# workflows, update
filter:
  org: { members: { user_id: { _eq: X-Hasura-User-Id }, role: { _in: [owner, editor] } } }
```

The role clause is inside the org traversal, not beside it, so "editor" is never a
global fact — it is always "editor *of this row's org*". An editor in Org A hitting
an Org B workflow matches zero rows.

This is why `owner`/`editor`/`viewer` are **not** Hasura roles. A user can be an
owner in one org and a viewer in another, while an nhost JWT carries a single global
`allowed-roles` set; selecting `editor` would grant editor rights in every org the
user belongs to. Role is per-org data, so it is checked as data. There is exactly one
authenticated Hasura role, `user`.

Two consequences are worth stating because they are what stops the UI from being the
security boundary. `workflow_runs` has **no** insert permission for any client role,
so a viewer cannot start a run by writing the row directly and skipping the hidden
Run button. `step_runs` has **no** insert, update, or delete permission, which is
what makes the approval gate real rather than decorative.

**Layer 2 — step-level gating — is the same mechanism with the step's own type
folded into the rule.** The required role depends on what is being inserted:

```yaml
# workflow_steps, insert
check:
  _or:
    - _and: [ { step_type: { owner_only: { _eq: false } } },
              { workflow: { org: { members: { user_id: {_eq: X-Hasura-User-Id}, role: {_in: [owner, editor]} } } } } ]
    - _and: [ { step_type: { owner_only: { _eq: true  } } },
              { workflow: { org: { members: { user_id: {_eq: X-Hasura-User-Id}, role: {_eq: owner} } } } } ]
```

`db_write` and `notify` are flagged `owner_only`, as is the `webhook` trigger type.
`type` is excluded from the updatable column list, so an editor cannot insert an
allowed step and then mutate it into a gated one — a hole that a naive insert-only
gate leaves wide open.

**Where a row permission cannot reach, the handler enforces it.** Two cases:

1. **Clearing an approval gate.** The check depends on the run's live state — is
   this step paused *right now*, is this run still `paused` — as well as the
   approver's role in that specific org. `approveStep` loads step_run → run →
   workflow → org, resolves the caller's role, compares it against the gate's own
   `allowed_roles`, and only then stamps the approver and resumes. Since `step_runs`
   grants no write permission to anyone, this handler is not the convenient path to
   approval; it is the only one.

2. **Revealing a webhook token.** Hasura column permissions are per-role, and role
   here is per-org data, so "owners see the token, editors do not" is not expressible
   as a column rule. `webhook_token` is excluded from every select permission and
   owners fetch the endpoint through the owner-only `getWebhookEndpoint` Action.

Both layers answer identically to a cross-org caller: **"Not found, or you do not
have access to it."** A distinguishable 404-vs-403 would let an Org B user confirm
that an Org A id exists by guessing it.

## Approval gate: pause and resume

The run carries a `cursor` — the position of the next step to execute — so resuming
is "continue from here", never a replay.

When the executor reaches an `approval_gate` it writes `step_runs.status =
awaiting_approval` and `workflow_runs.status = paused` in one mutation, leaves the
cursor *on* the gate, and returns. No timer, no held connection, no polling loop:
the run simply stops existing as work until something calls the executor again.

`approveStep` verifies the approver, then advances the cursor past the gate and sets
the run back to `running` in the same mutation — so no concurrent invocation can
observe an approved-but-still-paused run — and calls the executor through Next's
`after()`, which runs once the HTTP response has flushed. The approving client gets
its result immediately; the other browser watching the subscription sees the run
resume on its own. A rejection instead terminates the run as `rejected` and leaves
the record of who decided and when.

Resume uses the same entry point as a fresh run. Five things can drive a run forward
— manual Action, inbound webhook Action, cron dispatch, database event, and approval
resume — and all of them call `advanceRun`. That is only safe because of a lease:
`acquire_run_lock` is a single conditional `UPDATE` that returns the row only if the
run is runnable and unlocked, so redundant callers become no-ops instead of
executing a step twice. For an `llm_call` or `http_request` step, double execution
means a duplicated side effect, not just wasted time.

## Where the handlers run

The Actions, Event Trigger handlers and the cron dispatcher are nhost serverless
functions, in [`functions/`](../functions). Shared code sits in `functions/_lib`,
which nhost's router excludes from routing because of the leading underscore, so
the executor is importable without also being an endpoint.

nhost runs functions inside a long-lived Express server rather than a
per-invocation sandbox. Two consequences shaped the executor:

- **Work continues after the response.** An Action responds with the new run id
  immediately and then executes the run behind the response, which is what lets a
  client subscribe and watch steps light up rather than waiting for a single slow
  reply. On a per-invocation platform this needed `waitUntil`-style plumbing;
  here it is just a promise that is not awaited.
- **There is no function timeout to dodge.** An earlier version chopped runs into
  35-second slices and re-invoked itself over HTTP to survive a serverless limit.
  That machinery is gone: a run executes to completion in one pass, holding a
  15-minute lease.

What replaced it is a **stalled-run sweeper** on the same cron tick that dispatches
schedules. If a container is replaced mid-run, the run is left `running` with a
lease nobody holds; once that lease lapses and the row has been untouched for two
minutes, the sweeper calls `advanceRun` again. Because `advanceRun` re-acquires the
lease itself, a run that is actually healthy is skipped rather than double-executed.
This is strictly better than the self-continuation it replaced, which could only
recover from timeouts it predicted, not from a process dying.

## Quota

Two separate moments, as the brief specifies.

**At admission**, `triggerWorkflowRun` calls `roll_org_quota_period`, which resets
the counter if the calendar month has turned over and returns the org row. If
`quota_used >= quota_limit` the Action refuses with a `quota-exhausted` code and no
run is created. Rolling has to happen here rather than on a schedule, otherwise the
first run of a new month is measured against last month's counter.

**On completion**, whichever path takes the run terminal — success, failure after
retries, or a rejected approval gate — calls `countRunAgainstQuota`. A run that is
still executing has therefore not consumed anything, and a run that never finishes
never will.

Counting is claimed before it is applied:

```sql
UPDATE workflow_runs SET quota_counted = true
 WHERE id = $1 AND quota_counted = false
```

Zero affected rows means another invocation already counted this run, and the
increment is skipped. Six things can drive a run forward and a finalisation can be
reached more than once, so without that claim a single run could be counted twice.

Both functions return `SETOF organizations` rather than a scalar, because Hasura
only tracks functions returning `SETOF` a tracked table. That keeps the executor
talking GraphQL with no raw SQL built in application code. Neither declares a role
permission, so they are reachable only by the admin client and are absent from the
schema any browser session sees.

One honest limitation: because the check and the increment are separate, N runs
triggered simultaneously against an org with one call remaining can all pass the
check before any of them completes, and the org finishes the month marginally over
its limit. Closing that would mean reserving at admission, which is a different
behaviour from the one specified here.

## Retries and failure

`llm_call` and `http_request` run under `withRetry`, which distinguishes retryable
failures (network, timeout, 429, 5xx) from permanent ones (4xx, malformed config) and
does not waste an attempt on the latter. The attempt counter is persisted *before*
each try, so a retry is visible in the live feed as it happens rather than being
discoverable only in logs afterwards. A step that exhausts its attempts fails the
run with the error recorded on both the step and the run.

`notify` is the one step that does not do its own work: it inserts a `notifications`
row and returns, and a Hasura Event Trigger delivers it with its own retry policy.
A slow Slack endpoint therefore cannot stall or fail a workflow run.

## Trade-offs and known limits

- **Cron granularity.** One Hasura cron trigger fires every minute and dispatches
  per-workflow schedules by evaluating each trigger's own expression, so editing a
  schedule is a row update rather than a metadata change. A `tolerance_seconds`
  window plus a claimed `last_fired_at` minute keeps duplicate ticks idempotent.
- **Forward-only branches.** `conditional_branch` rejects backward jumps. There is no
  iteration limit in the model, so a backward jump would be an unbounded loop; steps
  the branch skips are marked `skipped` rather than silently omitted.
- **Context growth.** The run context accumulates every step's output in a JSONB
  column. It is truncated per HTTP response but not overall; a very long workflow
  with large payloads would want outputs kept out of the context and referenced by
  id.
- **Seeding needs the admin secret.** Creating an organization's *first* owner cannot
  satisfy the insert permission on `org_members`, which requires an existing owner of
  that same org. A production version would add a `createOrganization` Action that
  creates the org and its first membership in one transaction.
