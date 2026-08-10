import { NextResponse, after } from 'next/server';
import { verifyHasuraSecret } from '@/lib/action-request';
import { cronMatches, InvalidCron } from '@/lib/cron';
import { advanceRun } from '@/lib/executor';
import { gqlAdmin } from '@/lib/hasura';
import { QuotaExhausted, createRun, loadWorkflow } from '@/lib/start-run';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Hasura Cron Trigger, firing every minute.
 *
 * One platform-level cron drives every user-defined schedule: this reads each
 * active `scheduled` trigger's own cron expression and starts the ones due this
 * minute. A user editing a schedule in the UI is a row update, not a Hasura
 * metadata change — which is what makes per-workflow schedules practical at all.
 */
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  // Truncate to the minute so a trigger fires at most once per minute even if
  // Hasura delivers the tick twice or a retry arrives late.
  const thisMinute = new Date(now);
  thisMinute.setUTCSeconds(0, 0);

  try {
    const data = await gqlAdmin<{
      workflow_triggers: {
        id: string;
        workflow_id: string;
        cron: string | null;
        last_fired_at: string | null;
      }[];
    }>(
      `query ScheduledTriggers {
         workflow_triggers(
           where: {
             type: {_eq: "scheduled"},
             is_active: {_eq: true},
             workflow: {is_active: {_eq: true}}
           }
         ) { id workflow_id cron last_fired_at }
       }`,
    );

    const started: { trigger_id: string; run_id: string }[] = [];
    const errors: { trigger_id: string; error: string }[] = [];

    for (const trigger of data.workflow_triggers) {
      if (!trigger.cron) continue;

      try {
        if (!cronMatches(trigger.cron, thisMinute)) continue;

        // Idempotence guard for duplicate ticks.
        if (
          trigger.last_fired_at &&
          new Date(trigger.last_fired_at).getTime() >= thisMinute.getTime()
        ) {
          continue;
        }

        const workflow = await loadWorkflow(trigger.workflow_id);
        if (!workflow || workflow.steps.length === 0) continue;

        // Claim the minute before starting, so a concurrent tick sees it taken.
        const claim = await gqlAdmin<{
          update_workflow_triggers: { affected_rows: number };
        }>(
          `mutation ClaimTick($id: uuid!, $minute: timestamptz!) {
             update_workflow_triggers(
               where: {
                 id: {_eq: $id},
                 _or: [{last_fired_at: {_is_null: true}}, {last_fired_at: {_lt: $minute}}]
               },
               _set: {last_fired_at: $minute}
             ) { affected_rows }
           }`,
          { id: trigger.id, minute: thisMinute.toISOString() },
        );
        if (claim.update_workflow_triggers.affected_rows === 0) continue;

        const { runId } = await createRun({
          workflow,
          triggerType: 'scheduled',
          triggeredBy: null,
          input: { scheduled_for: thisMinute.toISOString(), cron: trigger.cron },
        });
        started.push({ trigger_id: trigger.id, run_id: runId });
        after(() => advanceRun(runId));
      } catch (err) {
        // A bad cron expression or an exhausted quota on one workflow must not
        // stop the rest of the tick.
        if (err instanceof InvalidCron || err instanceof QuotaExhausted) {
          errors.push({ trigger_id: trigger.id, error: err.message });
          continue;
        }
        throw err;
      }
    }

    return NextResponse.json({ at: thisMinute.toISOString(), started, errors });
  } catch (err) {
    console.error('[cron:dispatch]', err);
    return NextResponse.json({ message: 'Dispatch failed' }, { status: 500 });
  }
}
