import { NextResponse } from 'next/server';
import {
  actionError,
  sessionUserId,
  verifyHasuraSecret,
  type HasuraActionPayload,
} from '@/lib/action-request';
import { gqlAdmin } from '@/lib/hasura';
import { AccessDenied, assertOrgRole } from '@/lib/org-access';
import { serverEnv } from '@/lib/env';

export const runtime = 'nodejs';

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
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) return actionError('Unauthorized', 401);

  const payload = (await req.json()) as HasuraActionPayload<Input>;
  const userId = sessionUserId(payload);
  const triggerId = payload.input?.trigger_id;

  if (!triggerId) return actionError('trigger_id is required');

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
      return actionError('That trigger is not a webhook trigger', 400);
    }

    const url = `${serverEnv.hasuraUrl}`;
    const sample = [
      `curl -sS -X POST '${url}' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '{"query":"mutation($t:String!,$p:jsonb){triggerWorkflowByWebhook(webhook_token:$t,payload:$p){run_id status message}}",`,
      `      "variables":{"t":"${trigger.webhook_token}","p":{"subject":"Production database is down","source":"pagerduty"}}}'`,
    ].join('\n');

    return NextResponse.json({
      trigger_id: trigger.id,
      url,
      method: 'POST',
      sample_curl: sample,
    });
  } catch (err) {
    if (err instanceof AccessDenied) return actionError(err.message, 403, 'access-denied');
    console.error('[getWebhookEndpoint]', err);
    return actionError('Failed to load webhook endpoint', 500);
  }
}
