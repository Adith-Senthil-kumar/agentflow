import 'server-only';
import { gqlAdmin } from './hasura';
import { AccessDenied, getOrgRole } from './org-access';
import type { OrgRole, TriggerType, WorkflowStepRow } from './types';

export interface WorkflowSummary {
  id: string;
  org_id: string;
  name: string;
  is_active: boolean;
  steps: WorkflowStepRow[];
}

export class QuotaExhausted extends Error {
  constructor(
    readonly quotaUsed: number,
    readonly quotaLimit: number,
  ) {
    super(
      `Monthly quota exhausted for this organization (${quotaUsed}/${quotaLimit} runs used). ` +
        `Runs reset at the start of next month.`,
    );
    this.name = 'QuotaExhausted';
  }
}

export async function loadWorkflow(workflowId: string): Promise<WorkflowSummary | null> {
  const data = await gqlAdmin<{ workflows_by_pk: WorkflowSummary | null }>(
    `query LoadWorkflow($id: uuid!) {
       workflows_by_pk(id: $id) {
         id org_id name is_active
         steps(order_by: {position: asc}) { id workflow_id position type name config }
       }
     }`,
    { id: workflowId },
  );
  return data.workflows_by_pk;
}

/**
 * Step 1 of the Action: the caller must be owner or editor in the workflow's
 * own org.
 *
 * Non-membership and insufficient-role produce the same error, so an Org B user
 * probing an Org A workflow id cannot tell the two apart.
 */
export async function assertMayTriggerWorkflow(
  userId: string | null,
  workflow: WorkflowSummary,
): Promise<OrgRole> {
  if (!userId) throw new AccessDenied();

  const role = await getOrgRole(userId, workflow.org_id);
  if (!role) throw new AccessDenied();

  if (role === 'viewer') {
    throw new AccessDenied('Viewers cannot trigger runs in this organization');
  }

  return role;
}

/**
 * Step 2 of the Action: the org's quota must not be exhausted.
 *
 * Rolling the calendar window happens inside the same call, so the first run of
 * a new month is measured against a fresh counter rather than last month's.
 */
export async function assertQuotaAvailable(
  orgId: string,
): Promise<{ quotaUsed: number; quotaLimit: number }> {
  const data = await gqlAdmin<{
    roll_org_quota_period: { quota_used: number; quota_limit: number }[];
  }>(
    `mutation CheckQuota($orgId: uuid!) {
       roll_org_quota_period(args: {p_org_id: $orgId}) { quota_used quota_limit }
     }`,
    { orgId },
  );

  const org = data.roll_org_quota_period[0];
  if (!org) throw new AccessDenied();

  if (org.quota_used >= org.quota_limit) {
    throw new QuotaExhausted(org.quota_used, org.quota_limit);
  }
  return { quotaUsed: org.quota_used, quotaLimit: org.quota_limit };
}

/**
 * Creates the run together with a `pending` step_run for every step.
 *
 * Pre-creating the step rows means a client that subscribes immediately sees
 * the whole plan greyed out and watches it light up, instead of rows appearing
 * one at a time with no sense of what is still to come.
 *
 * `quota_counted` starts false; the executor flips it when the run reaches a
 * terminal state, which is where quota is actually consumed.
 */
export async function createRun(args: {
  workflow: WorkflowSummary;
  triggerType: TriggerType;
  triggeredBy: string | null;
  input?: Record<string, unknown>;
}): Promise<{ runId: string; quotaUsed: number; quotaLimit: number }> {
  const { workflow, triggerType, triggeredBy, input } = args;

  const { quotaUsed, quotaLimit } = await assertQuotaAvailable(workflow.org_id);

  const data = await gqlAdmin<{ insert_workflow_runs_one: { id: string } }>(
    `mutation CreateRun($object: workflow_runs_insert_input!) {
       insert_workflow_runs_one(object: $object) { id }
     }`,
    {
      object: {
        workflow_id: workflow.id,
        org_id: workflow.org_id,
        status: 'pending',
        trigger_type: triggerType,
        triggered_by: triggeredBy,
        quota_counted: false,
        context: { trigger: input ?? {} },
        cursor: 0,
        step_runs: {
          data: workflow.steps.map((s) => ({
            step_id: s.id,
            position: s.position,
            type: s.type,
            name: s.name,
            status: 'pending',
          })),
        },
      },
    },
  );

  return { runId: data.insert_workflow_runs_one.id, quotaUsed, quotaLimit };
}
