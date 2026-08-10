import { NextResponse, after } from 'next/server';
import {
  actionError,
  sessionUserId,
  verifyHasuraSecret,
  type HasuraActionPayload,
} from '@/lib/action-request';
import { advanceRun, countRunAgainstQuota } from '@/lib/executor';
import { gqlAdmin } from '@/lib/hasura';
import { AccessDenied, getOrgRole } from '@/lib/org-access';
import type { ApprovalGateConfig, OrgRole } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface Input {
  step_run_id: string;
  decision: 'approve' | 'reject';
  comment?: string;
}

interface StepRunDetail {
  id: string;
  status: string;
  position: number;
  type: string;
  step: { config: ApprovalGateConfig } | null;
  workflow_run: {
    id: string;
    status: string;
    cursor: number;
    workflow: { id: string; org_id: string; name: string };
  };
}

/**
 * Hasura Action: approveStep.
 *
 * This is the only way an approval_gate can be cleared. `step_runs` has no
 * insert/update/delete permission for any client role, so approving is not a
 * row write that this handler happens to wrap — the handler *is* the mechanism.
 *
 * That matters because the check is not expressible as a row permission: it
 * depends on the run's live state (is this step actually paused right now?) as
 * well as the approver's role in the org that owns the workflow.
 */
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) return actionError('Unauthorized', 401);

  const payload = (await req.json()) as HasuraActionPayload<Input>;
  const userId = sessionUserId(payload);
  const { step_run_id: stepRunId, decision, comment } = payload.input ?? {};

  if (!stepRunId) return actionError('step_run_id is required');
  if (decision !== 'approve' && decision !== 'reject') {
    return actionError('decision must be "approve" or "reject"');
  }

  try {
    if (!userId) throw new AccessDenied();

    const data = await gqlAdmin<{ step_runs_by_pk: StepRunDetail | null }>(
      `query ApprovalTarget($id: uuid!) {
         step_runs_by_pk(id: $id) {
           id status position type
           step { config }
           workflow_run {
             id status cursor
             workflow { id org_id name }
           }
         }
       }`,
      { id: stepRunId },
    );

    const stepRun = data.step_runs_by_pk;
    // Nonexistent and belonging-to-another-org are the same answer. An Org B
    // user pasting an Org A step_run id learns nothing about whether it exists.
    if (!stepRun) throw new AccessDenied();

    const orgId = stepRun.workflow_run.workflow.org_id;

    // --- the role check that cannot be a row permission ---------------------
    const role = await getOrgRole(userId, orgId);
    if (!role) throw new AccessDenied();

    const allowed: OrgRole[] = stepRun.step?.config?.allowed_roles?.length
      ? stepRun.step.config.allowed_roles
      : ['owner', 'editor'];

    if (!allowed.includes(role)) {
      return actionError(
        `Your role in this organization (${role}) cannot approve this step`,
        403,
        'access-denied',
      );
    }

    // --- state checks -------------------------------------------------------
    if (stepRun.type !== 'approval_gate') {
      return actionError('That step is not an approval gate', 400);
    }
    if (stepRun.status !== 'awaiting_approval') {
      return actionError(
        `This step is no longer awaiting approval (it is "${stepRun.status}")`,
        409,
        'not-pending',
      );
    }
    if (stepRun.workflow_run.status !== 'paused') {
      return actionError(
        `This run is not paused (it is "${stepRun.workflow_run.status}")`,
        409,
        'not-paused',
      );
    }

    const now = new Date().toISOString();
    const runId = stepRun.workflow_run.id;

    if (decision === 'reject') {
      await gqlAdmin(
        `mutation RejectStep($stepRunId: uuid!, $runId: uuid!, $now: timestamptz!, $output: jsonb!) {
           update_step_runs_by_pk(
             pk_columns: {id: $stepRunId},
             _set: {status: "rejected", approved_by: null, finished_at: $now, output: $output}
           ) { id }
           update_workflow_runs_by_pk(
             pk_columns: {id: $runId},
             _set: {status: "rejected", finished_at: $now, error: "Approval was rejected"}
           ) { id }
         }`,
        {
          stepRunId,
          runId,
          now,
          output: { decision: 'reject', by: userId, role, comment: comment ?? null, at: now },
        },
      );

      // A rejection ends the run, so it consumes quota like any other
      // completion — the LLM and HTTP calls before the gate already happened.
      await countRunAgainstQuota(runId, orgId);

      return NextResponse.json({
        step_run_id: stepRunId,
        run_id: runId,
        run_status: 'rejected',
        message: 'Run rejected at the approval gate',
      });
    }

    // Approve: stamp the approver, then move the cursor past the gate and put
    // the run back into `running` in the same mutation, so no other invocation
    // can observe an approved-but-still-paused state.
    await gqlAdmin(
      `mutation ApproveStep(
         $stepRunId: uuid!, $runId: uuid!, $userId: uuid!, $now: timestamptz!,
         $cursor: Int!, $output: jsonb!
       ) {
         update_step_runs_by_pk(
           pk_columns: {id: $stepRunId},
           _set: {status: "succeeded", approved_by: $userId, approved_at: $now, finished_at: $now, output: $output}
         ) { id }
         update_workflow_runs_by_pk(
           pk_columns: {id: $runId},
           _set: {status: "running", cursor: $cursor}
         ) { id }
       }`,
      {
        stepRunId,
        runId,
        userId,
        now,
        cursor: stepRun.position + 1,
        output: { decision: 'approve', by: userId, role, comment: comment ?? null, at: now },
      },
    );

    after(() => advanceRun(runId));

    return NextResponse.json({
      step_run_id: stepRunId,
      run_id: runId,
      run_status: 'running',
      message: `Approved by ${role}; run resumed`,
    });
  } catch (err) {
    if (err instanceof AccessDenied) return actionError(err.message, 403, 'access-denied');
    console.error('[approveStep]', err);
    return actionError('Failed to process approval', 500);
  }
}
