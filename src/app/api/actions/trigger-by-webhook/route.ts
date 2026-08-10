import { NextResponse, after } from 'next/server';
import { actionError, verifyHasuraSecret, type HasuraActionPayload } from '@/lib/action-request';
import { advanceRun } from '@/lib/executor';
import { gqlAdmin } from '@/lib/hasura';
import { QuotaExhausted, createRun, loadWorkflow } from '@/lib/start-run';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
 * resolves the workflow. A caller cannot name a workflow id at all, which means
 * there is nothing to guess — an Org B system holding no Org A token has no
 * reachable surface, and a leaked token can be rotated by deleting the trigger.
 */
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) return actionError('Unauthorized', 401);

  const payload = (await req.json()) as HasuraActionPayload<Input>;
  const token = payload.input?.webhook_token;

  if (!token || typeof token !== 'string') {
    return actionError('webhook_token is required', 400);
  }

  try {
    const data = await gqlAdmin<{
      workflow_triggers: {
        id: string;
        is_active: boolean;
        workflow_id: string;
        config: Record<string, unknown>;
      }[];
    }>(
      `query ResolveWebhook($token: String!) {
         workflow_triggers(
           where: {webhook_token: {_eq: $token}, type: {_eq: "webhook"}},
           limit: 1
         ) { id is_active workflow_id config }
       }`,
      { token },
    );

    const trigger = data.workflow_triggers[0];
    // Same opaque answer for an unknown token and a deactivated one.
    if (!trigger || !trigger.is_active) {
      return actionError('Invalid or inactive webhook token', 403, 'invalid-token');
    }

    const workflow = await loadWorkflow(trigger.workflow_id);
    if (!workflow || !workflow.is_active) {
      return actionError('Invalid or inactive webhook token', 403, 'invalid-token');
    }
    if (workflow.steps.length === 0) {
      return actionError('This workflow has no steps yet', 400, 'workflow-empty');
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

    after(() => advanceRun(runId));

    return NextResponse.json({
      run_id: runId,
      status: 'started',
      message: `Run started for "${workflow.name}" via webhook`,
      quota_used: quotaUsed,
      quota_limit: quotaLimit,
    });
  } catch (err) {
    if (err instanceof QuotaExhausted)
      return actionError(err.message, 429, 'quota-exhausted');
    console.error('[triggerWorkflowByWebhook]', err);
    return actionError('Failed to start run', 500);
  }
}
