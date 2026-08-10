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
 * Step-level gating on the *trigger* path, enforced here in the handler.
 *
 * The Hasura insert permission already stops an editor from adding a db_write
 * or notify step. This is the matching rule for causing one to execute: if a
 * workflow contains any owner-only step type, only an owner may start it.
 * Configuring a privileged side effect and firing it are the same privilege —
 * otherwise an editor could not add a db_write step but could still trigger a
 * workflow full of them, and the insert gate would be decorative.
 *
 * The owner-only set is read from `step_types.owner_only`, the same column the
 * Hasura permission reads, so the two layers cannot drift apart.
 */
export async function assertMayTriggerWorkflow(
  userId: string | null,
  workflow: WorkflowSummary,
): Promise<OrgRole> {
  if (!userId) throw new AccessDenied();

  const role = await getOrgRole(userId, workflow.org_id);
  if (!role) throw new AccessDenied();

  // Layer 1: viewers can never start a run.
  if (role === 'viewer') {
    throw new AccessDenied('Viewers cannot trigger runs in this organization');
  }

  // Layer 2: owner-only step types raise the bar for the whole workflow.
  const gated = await ownerOnlyStepTypesIn(workflow.steps.map((s) => s.type));
  if (gated.length > 0 && role !== 'owner') {
    throw new AccessDenied(
      `This workflow contains owner-only step types (${gated.join(', ')}), so only an owner can start it`,
    );
  }

  return role;
}

/** Which of these step types are flagged owner_only in the database. */
export async function ownerOnlyStepTypesIn(types: string[]): Promise<string[]> {
  if (types.length === 0) return [];
  const data = await gqlAdmin<{ step_types: { value: string }[] }>(
    `query OwnerOnlyTypes($types: [String!]!) {
       step_types(where: {value: {_in: $types}, owner_only: {_eq: true}}) { value }
     }`,
    { types: Array.from(new Set(types)) },
  );
  return data.step_types.map((r) => r.value);
}

/**
 * Reserves quota, then creates the run together with a `pending` step_run for
 * every step.
 *
 * Pre-creating the step rows means a client that subscribes immediately sees
 * the whole plan greyed out and watches it light up, instead of rows appearing
 * one at a time with no sense of what is still to come.
 */
export async function createRun(args: {
  workflow: WorkflowSummary;
  triggerType: TriggerType;
  triggeredBy: string | null;
  input?: Record<string, unknown>;
}): Promise<{ runId: string; quotaUsed: number; quotaLimit: number }> {
  const { workflow, triggerType, triggeredBy, input } = args;

  // Atomic check-and-reserve. Zero rows back means the org is at its limit.
  const quota = await gqlAdmin<{
    consume_org_quota: { id: string; quota_used: number; quota_limit: number }[];
  }>(
    `mutation ReserveQuota($orgId: uuid!) {
       consume_org_quota(args: {p_org_id: $orgId}) { id quota_used quota_limit }
     }`,
    { orgId: workflow.org_id },
  );

  const reserved = quota.consume_org_quota[0];
  if (!reserved) {
    const current = await gqlAdmin<{
      organizations_by_pk: { quota_used: number; quota_limit: number } | null;
    }>(
      `query QuotaState($orgId: uuid!) {
         organizations_by_pk(id: $orgId) { quota_used quota_limit }
       }`,
      { orgId: workflow.org_id },
    );
    throw new QuotaExhausted(
      current.organizations_by_pk?.quota_used ?? 0,
      current.organizations_by_pk?.quota_limit ?? 0,
    );
  }

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
        quota_counted: true,
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

  return {
    runId: data.insert_workflow_runs_one.id,
    quotaUsed: reserved.quota_used,
    quotaLimit: reserved.quota_limit,
  };
}
