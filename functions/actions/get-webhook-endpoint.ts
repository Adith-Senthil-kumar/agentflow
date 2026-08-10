import type { Request, Response } from 'express';
import {
  actionError,
  sessionUserId,
  verifyHasuraSecret,
  type HasuraActionPayload,
} from '../_lib/http';
import { serverEnv } from '../_lib/env';
import { gqlAdmin } from '../_lib/hasura';
import { AccessDenied, assertOrgRole } from '../_lib/org-access';

interface Input {
  trigger_id: string;
}

/**
 * Hasura Action: getWebhookEndpoint.
 *
 * `workflow_triggers.webhook_token` is excluded from the table's select
 * permission, so no client role can read it through the normal API. Hasura
 * column permissions are per-role rather than per-row, and org role is per-org
 * data here, so "owners see the token, editors do not" is not expressible as a
 * column permission at all — it has to be a handler check. This is that check.
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
  const triggerId = payload.input?.trigger_id;

  if (!triggerId) {
    actionError(res, 'trigger_id is required');
    return;
  }

  try {
    const data = await gqlAdmin<{
      workflow_triggers_by_pk: {
        id: string;
        type: string;
        webhook_token: string | null;
        workflow: { org_id: string; name: string };
      } | null;
    }>(
      `query TriggerForEndpoint($id: uuid!) {
         workflow_triggers_by_pk(id: $id) {
           id type webhook_token
           workflow { org_id name }
         }
       }`,
      { id: triggerId },
    );

    const trigger = data.workflow_triggers_by_pk;
    if (!trigger) throw new AccessDenied();

    // Owner-only, scoped to this trigger's own org.
    await assertOrgRole(userId, trigger.workflow.org_id, ['owner']);

    if (trigger.type !== 'webhook' || !trigger.webhook_token) {
      actionError(res, 'That trigger is not a webhook trigger', 400);
      return;
    }

    const url = serverEnv.hasuraUrl;
    const sample = [
      `curl -sS -X POST '${url}' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '{"query":"mutation($t:String!,$p:jsonb){triggerWorkflowByWebhook(webhook_token:$t,payload:$p){run_id status message}}",`,
      `      "variables":{"t":"${trigger.webhook_token}","p":{"subject":"Production database is down","source":"pagerduty"}}}'`,
    ].join('\n');

    res.status(200).json({
      trigger_id: trigger.id,
      url,
      method: 'POST',
      sample_curl: sample,
    });
  } catch (err) {
    if (err instanceof AccessDenied) {
      actionError(res, err.message, 403, 'access-denied');
      return;
    }
    console.error('[getWebhookEndpoint]', err);
    actionError(res, 'Failed to load webhook endpoint', 500);
  }
}
