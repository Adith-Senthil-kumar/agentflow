import { randomUUID } from 'node:crypto';
import { gqlAdmin } from './hasura';
import { renderDeep } from './template';
import { PermanentError } from './retry';
import { executeConditionalBranch } from './steps/conditional-branch';
import { executeDbWrite } from './steps/db-write';
import { executeHttpRequest } from './steps/http-request';
import { executeLlmCall } from './steps/llm-call';
import { executeNotify } from './steps/notify';
import type { StepExecutor } from './steps/types';
import type {
  ApprovalGateConfig,
  BranchAction,
  RunContext,
  StepType,
  WorkflowRunRow,
  WorkflowStepRow,
} from './types';

/**
 * How long a run's execution lease is held.
 *
 * nhost functions run inside a long-lived server, so a run executes to
 * completion in one go rather than being chopped into invocations. The lease
 * therefore only needs to outlast a realistic run; if the container dies
 * mid-run it expires and the stalled-run sweeper on the cron tick picks the run
 * back up.
 */
const LEASE_SECONDS = 900;

const EXECUTORS: Record<Exclude<StepType, 'approval_gate'>, StepExecutor> = {
  llm_call: executeLlmCall,
  http_request: executeHttpRequest,
  db_write: executeDbWrite,
  notify: executeNotify,
  conditional_branch: executeConditionalBranch,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Drives a run to completion, or to its next approval gate.
 *
 * Safe to call concurrently and safe to call on a run that is already finished:
 * the lease makes redundant calls no-ops rather than duplicate executions. That
 * matters because five different things can call this — manual Action, inbound
 * webhook, cron dispatch, database event, and approval resume — and for an
 * llm_call or http_request step a double execution is a duplicated side effect,
 * not just wasted time.
 */
export async function advanceRun(runId: string): Promise<void> {
  const token = randomUUID();
  const run = await acquireLock(runId, token);
  if (!run) return; // finished, or another caller holds the lease

  try {
    await drive(run);
  } catch (err) {
    await failRun(runId, err);
  } finally {
    await releaseLock(runId, token);
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function drive(run: WorkflowRunRow): Promise<void> {
  const steps = await loadSteps(run.workflow_id);

  if (steps.length === 0) {
    await failRun(run.id, new PermanentError('Workflow has no steps'));
    return;
  }

  if (run.status === 'pending') await markRunning(run.id);

  let ctx: RunContext = run.context ?? {};
  let cursor = run.cursor;

  while (cursor < steps.length) {
    const step = steps[cursor];
    const stepRunId = await beginStepRun(run.id, step, ctx);

    // ---- approval_gate: stop the run here and wait for approveStep ----------
    if (step.type === 'approval_gate') {
      const cfg = (step.config ?? {}) as ApprovalGateConfig;
      await pauseForApproval(run.id, stepRunId, cursor, ctx, cfg);
      return;
    }

    try {
      const config = renderDeep(step.config ?? {}, ctx) as Record<string, unknown>;
      const executor = EXECUTORS[step.type as Exclude<StepType, 'approval_gate'>];
      if (!executor) throw new PermanentError(`Unsupported step type: ${step.type}`);

      const result = await executor({
        step,
        config,
        ctx,
        run,
        stepRunId,
        onAttempt: (attempt) => recordAttempt(stepRunId, attempt),
      });

      ctx = {
        ...ctx,
        steps: { ...(ctx.steps ?? {}), [step.name]: result.output },
        last: result.output,
      };
      await completeStepRun(stepRunId, result.output);

      cursor = result.branch
        ? await applyBranch(run.id, steps, cursor, result.branch)
        : cursor + 1;

      await saveProgress(run.id, cursor, ctx);
    } catch (err) {
      await failStepRun(stepRunId, err);
      await failRun(run.id, err);
      return;
    }
  }

  await succeedRun(run.id, ctx);
}

/**
 * Moves the cursor for a conditional_branch and marks any steps it jumped over
 * as `skipped`, so the untaken branch is visible in the run timeline instead of
 * just missing.
 *
 * Jumps are forward-only. A backward `goto` would let a workflow loop forever,
 * and there is no iteration limit to stop it, so it is rejected outright rather
 * than silently clamped.
 */
async function applyBranch(
  runId: string,
  steps: WorkflowStepRow[],
  cursor: number,
  branch: BranchAction,
): Promise<number> {
  if (branch.action === 'continue') return cursor + 1;

  const target = branch.action === 'end' ? steps.length : branch.position;

  if (branch.action === 'goto') {
    if (!Number.isInteger(target) || target <= cursor) {
      throw new PermanentError(
        `conditional_branch can only jump forward; got position ${branch.position} at step ${cursor}`,
      );
    }
    if (target > steps.length) {
      throw new PermanentError(
        `conditional_branch targets position ${branch.position}, past the last step`,
      );
    }
  }

  const skipped = steps.slice(cursor + 1, target).map((s) => s.position);
  if (skipped.length > 0) await markSkipped(runId, skipped);

  return target;
}

// ---------------------------------------------------------------------------
// Persistence helpers. Each one is a discrete write so the subscription sees
// progress as it happens rather than in one burst at the end.
// ---------------------------------------------------------------------------

const RUN_FIELDS = `id workflow_id org_id status trigger_type triggered_by context cursor quota_counted`;

async function acquireLock(runId: string, token: string): Promise<WorkflowRunRow | null> {
  const data = await gqlAdmin<{ acquire_run_lock: WorkflowRunRow[] }>(
    `mutation AcquireLock($runId: uuid!, $token: uuid!, $ttl: Int!) {
       acquire_run_lock(args: {p_run_id: $runId, p_token: $token, p_ttl_seconds: $ttl}) {
         ${RUN_FIELDS}
       }
     }`,
    { runId, token, ttl: LEASE_SECONDS },
  );
  return data.acquire_run_lock[0] ?? null;
}

async function releaseLock(runId: string, token: string): Promise<void> {
  await gqlAdmin(
    `mutation ReleaseLock($runId: uuid!, $token: uuid!) {
       release_run_lock(args: {p_run_id: $runId, p_token: $token}) { id }
     }`,
    { runId, token },
  );
}

async function loadSteps(workflowId: string): Promise<WorkflowStepRow[]> {
  const data = await gqlAdmin<{ workflow_steps: WorkflowStepRow[] }>(
    `query Plan($workflowId: uuid!) {
       workflow_steps(where: {workflow_id: {_eq: $workflowId}}, order_by: {position: asc}) {
         id workflow_id position type name config
       }
     }`,
    { workflowId },
  );
  return data.workflow_steps;
}

async function markRunning(runId: string): Promise<void> {
  await gqlAdmin(
    `mutation MarkRunning($runId: uuid!, $now: timestamptz!) {
       update_workflow_runs_by_pk(
         pk_columns: {id: $runId},
         _set: {status: "running", started_at: $now}
       ) { id }
     }`,
    { runId, now: new Date().toISOString() },
  );
}

async function beginStepRun(
  runId: string,
  step: WorkflowStepRow,
  ctx: RunContext,
): Promise<string> {
  const input = { config: step.config, context_at_entry: { last: ctx.last ?? null } };

  // Rows are pre-created as `pending` when the run starts, so the whole plan is
  // visible in the UI before anything executes. upsert covers the case where a
  // step was added to the workflow after the run began.
  const data = await gqlAdmin<{
    insert_step_runs_one: { id: string };
  }>(
    `mutation BeginStep($object: step_runs_insert_input!) {
       insert_step_runs_one(
         object: $object,
         on_conflict: {
           constraint: step_runs_workflow_run_id_position_key,
           update_columns: [status, started_at, input, type, name, step_id]
         }
       ) { id }
     }`,
    {
      object: {
        workflow_run_id: runId,
        step_id: step.id,
        position: step.position,
        type: step.type,
        name: step.name,
        status: 'running',
        started_at: new Date().toISOString(),
        input,
      },
    },
  );
  return data.insert_step_runs_one.id;
}

async function recordAttempt(stepRunId: string, attempt: number): Promise<void> {
  await gqlAdmin(
    `mutation RecordAttempt($id: uuid!, $attempt: Int!) {
       update_step_runs_by_pk(pk_columns: {id: $id}, _set: {attempt: $attempt}) { id }
     }`,
    { id: stepRunId, attempt },
  );
}

async function completeStepRun(stepRunId: string, output: unknown): Promise<void> {
  await gqlAdmin(
    `mutation CompleteStep($id: uuid!, $output: jsonb, $now: timestamptz!) {
       update_step_runs_by_pk(
         pk_columns: {id: $id},
         _set: {status: "succeeded", output: $output, finished_at: $now}
       ) { id }
     }`,
    { id: stepRunId, output: output ?? null, now: new Date().toISOString() },
  );
}

async function failStepRun(stepRunId: string, err: unknown): Promise<void> {
  await gqlAdmin(
    `mutation FailStep($id: uuid!, $error: String!, $now: timestamptz!) {
       update_step_runs_by_pk(
         pk_columns: {id: $id},
         _set: {status: "failed", error: $error, finished_at: $now}
       ) { id }
     }`,
    { id: stepRunId, error: errorMessage(err), now: new Date().toISOString() },
  );
}

async function markSkipped(runId: string, positions: number[]): Promise<void> {
  await gqlAdmin(
    `mutation SkipSteps($runId: uuid!, $positions: [Int!]!, $now: timestamptz!) {
       update_step_runs(
         where: {workflow_run_id: {_eq: $runId}, position: {_in: $positions}, status: {_eq: "pending"}},
         _set: {status: "skipped", finished_at: $now}
       ) { affected_rows }
     }`,
    { runId, positions, now: new Date().toISOString() },
  );
}

async function pauseForApproval(
  runId: string,
  stepRunId: string,
  cursor: number,
  ctx: RunContext,
  cfg: ApprovalGateConfig,
): Promise<void> {
  const now = new Date().toISOString();
  await gqlAdmin(
    `mutation PauseForApproval(
       $stepRunId: uuid!, $runId: uuid!, $cursor: Int!, $ctx: jsonb!, $output: jsonb, $now: timestamptz!
     ) {
       update_step_runs_by_pk(
         pk_columns: {id: $stepRunId},
         _set: {status: "awaiting_approval", started_at: $now, output: $output}
       ) { id }
       update_workflow_runs_by_pk(
         pk_columns: {id: $runId},
         _set: {status: "paused", cursor: $cursor, context: $ctx}
       ) { id }
     }`,
    {
      stepRunId,
      runId,
      // The cursor stays ON the gate. approveStep advances it, so an approval
      // resumes at the step after the gate and a rejection leaves a coherent
      // record of exactly where the run stopped.
      cursor,
      ctx,
      output: {
        awaiting_approval: true,
        instructions: cfg.instructions ?? 'Approval required to continue this run.',
        allowed_roles: cfg.allowed_roles ?? ['owner', 'editor'],
      },
      now,
    },
  );
}

async function saveProgress(runId: string, cursor: number, ctx: RunContext): Promise<void> {
  await gqlAdmin(
    `mutation SaveProgress($runId: uuid!, $cursor: Int!, $ctx: jsonb!) {
       update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {cursor: $cursor, context: $ctx}) { id }
     }`,
    { runId, cursor, ctx },
  );
}

async function succeedRun(runId: string, ctx: RunContext): Promise<void> {
  const data = await gqlAdmin<{
    update_workflow_runs_by_pk: { id: string; org_id: string } | null;
  }>(
    `mutation SucceedRun($runId: uuid!, $ctx: jsonb!, $now: timestamptz!) {
       update_workflow_runs_by_pk(
         pk_columns: {id: $runId},
         _set: {status: "succeeded", context: $ctx, finished_at: $now}
       ) { id org_id }
     }`,
    { runId, ctx, now: new Date().toISOString() },
  );
  const org = data.update_workflow_runs_by_pk?.org_id;
  if (org) await countRunAgainstQuota(runId, org);
}

async function failRun(runId: string, err: unknown): Promise<void> {
  const data = await gqlAdmin<{
    update_workflow_runs_by_pk: { id: string; org_id: string } | null;
  }>(
    `mutation FailRun($runId: uuid!, $error: String!, $now: timestamptz!) {
       update_workflow_runs_by_pk(
         pk_columns: {id: $runId},
         _set: {status: "failed", error: $error, finished_at: $now}
       ) { id org_id }
     }`,
    { runId, error: errorMessage(err), now: new Date().toISOString() },
  );
  const org = data.update_workflow_runs_by_pk?.org_id;
  if (org) await countRunAgainstQuota(runId, org);
}

/**
 * Consumes one unit of the org's monthly quota for a run that has just reached
 * a terminal state.
 *
 * The run is claimed first with a conditional update on `quota_counted`. Six
 * things can drive a run and a finalisation can be reached more than once, so
 * without the claim a single run could be counted twice. Zero affected rows
 * means someone else already counted it.
 */
export async function countRunAgainstQuota(runId: string, orgId: string): Promise<void> {
  const claim = await gqlAdmin<{ update_workflow_runs: { affected_rows: number } }>(
    `mutation ClaimQuotaCount($runId: uuid!) {
       update_workflow_runs(
         where: {id: {_eq: $runId}, quota_counted: {_eq: false}},
         _set: {quota_counted: true}
       ) { affected_rows }
     }`,
    { runId },
  );
  if (claim.update_workflow_runs.affected_rows === 0) return;

  await gqlAdmin(
    `mutation IncrementQuota($orgId: uuid!) {
       increment_org_quota(args: {p_org_id: $orgId}) { id quota_used quota_limit }
     }`,
    { orgId },
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 2000);
  return String(err).slice(0, 2000);
}
