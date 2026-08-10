import type { Request, Response } from 'express';
import {
  actionError,
  runInBackground,
  verifyHasuraSecret,
  type HasuraActionPayload,
} from '../_lib/http';
import { advanceRun } from '../_lib/executor';
import { gqlAdmin } from '../_lib/hasura';
import { QuotaExhausted, createRun, loadWorkflow } from '../_lib/start-run';

interface Input {
  webhook_token: string;
  payload?: Record<string, unknown>;
}

/**
 * Hasura Action: triggerWorkflowByWebhook — the inbound endpoint external
 * systems call to start a run. Exposed to the unauthenticated `public` role.
 *
 * There is no user session here, so authorisation works differently from the
 * manual path: the caller presents an opaque token, and the token is what
 * resolves the workflow. A caller cannot name a workflow id at all, so there is
 * nothing to guess — an Org B system holding no Org A token has no reachable
 * surface, and a leaked token is revoked by deleting the trigger.
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
  const token = payload.input?.webhook_token;

  if (!token || typeof token !== 'string') {
    actionError(res, 'webhook_token is required', 400);
    return;
  }

  try {
    const data = await gqlAdmin<{
      workflow_triggers: {
        id: string;
        is_active: boolean;
        workflow_id: string;
      }[];
    }>(
      `query ResolveWebhook($token: String!) {
         workflow_triggers(
           where: {webhook_token: {_eq: $token}, type: {_eq: "webhook"}},
           limit: 1
         ) { id is_active workflow_id }
       }`,
      { token },
    );

    const trigger = data.workflow_triggers[0];
    // Same opaque answer for an unknown token and a deactivated one.
    if (!trigger || !trigger.is_active) {
      actionError(res, 'Invalid or inactive webhook token', 403, 'invalid-token');
      return;
    }

    const workflow = await loadWorkflow(trigger.workflow_id);
    if (!workflow || !workflow.is_active) {
      actionError(res, 'Invalid or inactive webhook token', 403, 'invalid-token');
      return;
    }
    if (workflow.steps.length === 0) {
      actionError(res, 'This workflow has no steps yet', 400, 'workflow-empty');
      return;
    }

    const { runId, quotaUsed, quotaLimit } = await createRun({
      workflow,
      triggerType: 'webhook',
      // No user is responsible for a webhook run; the trigger row is the actor.
      triggeredBy: null,
      input: { ...(payload.input?.payload ?? {}), _trigger_id: trigger.id },
    });

    await gqlAdmin(
      `mutation MarkFired($id: uuid!, $now: timestamptz!) {
         update_workflow_triggers_by_pk(pk_columns: {id: $id}, _set: {last_fired_at: $now}) { id }
       }`,
      { id: trigger.id, now: new Date().toISOString() },
    );

    res.status(200).json({
      run_id: runId,
      status: 'started',
      message: `Run started for "${workflow.name}" via webhook`,
      quota_used: quotaUsed,
      quota_limit: quotaLimit,
    });

    runInBackground(() => advanceRun(runId), `webhook:${runId}`);
  } catch (err) {
    if (err instanceof QuotaExhausted) {
      actionError(res, err.message, 429, 'quota-exhausted');
      return;
    }
    console.error('[triggerWorkflowByWebhook]', err);
    actionError(res, 'Failed to start run', 500);
  }
}
