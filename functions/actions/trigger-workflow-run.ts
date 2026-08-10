import type { Request, Response } from 'express';
import {
  actionError,
  runInBackground,
  sessionUserId,
  verifyHasuraSecret,
  type HasuraActionPayload,
} from '../_lib/http';
import { advanceRun } from '../_lib/executor';
import { AccessDenied } from '../_lib/org-access';
import {
  QuotaExhausted,
  assertMayTriggerWorkflow,
  createRun,
  loadWorkflow,
} from '../_lib/start-run';

interface Input {
  workflow_id: string;
  input?: Record<string, unknown>;
}

/**
 * Hasura Action: triggerWorkflowRun.
 *
 *   1. verify the request really came from Hasura
 *   2. verify the caller is owner|editor in the *workflow's* org
 *   3. check the org's quota is not exhausted
 *   4. create the run and respond immediately with its id
 *   5. execute in the background, so the client's subscription shows progress
 *      step by step instead of everything arriving at the end
 */
export default async function handler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    actionError(res, 'Method not allowed', 405);
    return;
  }
  if (!verifyHasuraSecret(req)) {
    actionError(res, 'Unauthorized', 401);
    return;
  }

  const payload = req.body as HasuraActionPayload<Input>;
  const userId = sessionUserId(payload);
  const workflowId = payload.input?.workflow_id;

  if (!workflowId) {
    actionError(res, 'workflow_id is required');
    return;
  }

  try {
    const workflow = await loadWorkflow(workflowId);

    // A workflow that does not exist and one belonging to another org produce
    // the identical error, so ids cannot be probed for existence.
    if (!workflow) throw new AccessDenied();

    await assertMayTriggerWorkflow(userId, workflow);

    if (!workflow.is_active) {
      actionError(res, 'This workflow is disabled', 400, 'workflow-inactive');
      return;
    }
    if (workflow.steps.length === 0) {
      actionError(res, 'This workflow has no steps yet', 400, 'workflow-empty');
      return;
    }

    const { runId, quotaUsed, quotaLimit } = await createRun({
      workflow,
      triggerType: 'manual',
      triggeredBy: userId,
      input: payload.input?.input,
    });

    res.status(200).json({
      run_id: runId,
      status: 'started',
      message: `Run started for "${workflow.name}"`,
      quota_used: quotaUsed,
      quota_limit: quotaLimit,
    });

    runInBackground(() => advanceRun(runId), `run:${runId}`);
  } catch (err) {
    if (err instanceof AccessDenied) {
      actionError(res, err.message, 403, 'access-denied');
      return;
    }
    if (err instanceof QuotaExhausted) {
      actionError(res, err.message, 429, 'quota-exhausted');
      return;
    }
    console.error('[triggerWorkflowRun]', err);
    actionError(res, 'Failed to start run', 500);
  }
}
