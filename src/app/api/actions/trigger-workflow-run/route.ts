import { NextResponse, after } from 'next/server';
import {
  actionError,
  sessionUserId,
  verifyHasuraSecret,
  type HasuraActionPayload,
} from '@/lib/action-request';
import { advanceRun } from '@/lib/executor';
import { AccessDenied } from '@/lib/org-access';
import {
  QuotaExhausted,
  assertMayTriggerWorkflow,
  createRun,
  loadWorkflow,
} from '@/lib/start-run';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface Input {
  workflow_id: string;
  input?: Record<string, unknown>;
}

/**
 * Hasura Action: triggerWorkflowRun.
 *
 *   1. verify the request really came from Hasura
 *   2. verify the caller is owner|editor in the *workflow's* org (Layer 1)
 *      and may cause its step types to execute (Layer 2)
 *   3. reserve quota atomically
 *   4. create the run and return immediately
 *   5. execute in the background so the client's subscription shows progress
 */
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) {
    return actionError('Unauthorized', 401);
  }

  const payload = (await req.json()) as HasuraActionPayload<Input>;
  const userId = sessionUserId(payload);
  const workflowId = payload.input?.workflow_id;

  if (!workflowId) return actionError('workflow_id is required');

  try {
    const workflow = await loadWorkflow(workflowId);

    // A workflow that does not exist and one belonging to another org produce
    // the identical error, so ids cannot be probed for existence.
    if (!workflow) throw new AccessDenied();

    await assertMayTriggerWorkflow(userId, workflow);

    if (!workflow.is_active) {
      return actionError('This workflow is disabled', 400, 'workflow-inactive');
    }
    if (workflow.steps.length === 0) {
      return actionError('This workflow has no steps yet', 400, 'workflow-empty');
    }

    const { runId, quotaUsed, quotaLimit } = await createRun({
      workflow,
      triggerType: 'manual',
      triggeredBy: userId,
      input: payload.input?.input,
    });

    // Runs after the response is flushed, so the mutation returns a run_id in
    // milliseconds and the UI can subscribe before the first step finishes.
    after(() => advanceRun(runId));

    return NextResponse.json({
      run_id: runId,
      status: 'started',
      message: `Run started for "${workflow.name}"`,
      quota_used: quotaUsed,
      quota_limit: quotaLimit,
    });
  } catch (err) {
    if (err instanceof AccessDenied) return actionError(err.message, 403, 'access-denied');
    if (err instanceof QuotaExhausted)
      return actionError(err.message, 429, 'quota-exhausted');
    console.error('[triggerWorkflowRun]', err);
    return actionError('Failed to start run', 500);
  }
}
