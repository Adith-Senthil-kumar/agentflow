import { NextResponse, after } from 'next/server';
import { verifyHasuraSecret } from '@/lib/action-request';
import { advanceRun } from '@/lib/executor';
import { gqlAdmin } from '@/lib/hasura';
import { QuotaExhausted, createRun, loadWorkflow } from '@/lib/start-run';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface EventPayload {
  event: {
    op: 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';
    data: { new: Record<string, unknown> | null; old: Record<string, unknown> | null };
  };
  table: { schema: string; name: string };
}

/**
 * Hasura Event Trigger: a row landed in `watched_records`.
 *
 * Starts a run of every active `database_event` workflow in that row's org —
 * no button click anywhere. The org comes from the inserted row, so a record
 * created in Org B can only ever start Org B workflows.
 */
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json()) as EventPayload;
  const row = body.event?.data?.new;
  if (!row) return NextResponse.json({ skipped: 'no new row' });

  const orgId = row.org_id as string;
  const kind = (row.kind as string) ?? null;

  try {
    const data = await gqlAdmin<{
      workflow_triggers: { id: string; workflow_id: string; config: Record<string, unknown> }[];
    }>(
      `query DatabaseEventTriggers($orgId: uuid!) {
         workflow_triggers(
           where: {
             type: {_eq: "database_event"},
             is_active: {_eq: true},
             workflow: {is_active: {_eq: true}, org_id: {_eq: $orgId}}
           }
         ) { id workflow_id config }
       }`,
      { orgId },
    );

    const started: string[] = [];
    const skipped: string[] = [];

    for (const trigger of data.workflow_triggers) {
      // A trigger may narrow itself to one record kind.
      const wanted = trigger.config?.kind;
      if (wanted && wanted !== kind) {
        skipped.push(trigger.id);
        continue;
      }

      const workflow = await loadWorkflow(trigger.workflow_id);
      if (!workflow || workflow.steps.length === 0) continue;

      try {
        const { runId } = await createRun({
          workflow,
          triggerType: 'database_event',
          triggeredBy: (row.created_by as string) ?? null,
          input: { record: row, table: body.table?.name, op: body.event?.op },
        });
        await gqlAdmin(
          `mutation MarkFired($id: uuid!, $now: timestamptz!) {
             update_workflow_triggers_by_pk(pk_columns: {id: $id}, _set: {last_fired_at: $now}) { id }
           }`,
          { id: trigger.id, now: new Date().toISOString() },
        );
        started.push(runId);
        after(() => advanceRun(runId));
      } catch (err) {
        // One org hitting its quota must not stop the other triggers from
        // firing, and must not make Hasura retry the whole event.
        if (err instanceof QuotaExhausted) {
          skipped.push(trigger.id);
          continue;
        }
        throw err;
      }
    }

    return NextResponse.json({ started, skipped });
  } catch (err) {
    console.error('[event:watched-record]', err);
    // 500 lets Hasura's retry policy have another go.
    return NextResponse.json({ message: 'Failed to dispatch' }, { status: 500 });
  }
}
