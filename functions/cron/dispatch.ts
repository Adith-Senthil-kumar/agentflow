import type { Request, Response } from 'express';
import { runInBackground, verifyHasuraSecret } from '../_lib/http';
import { cronMatches, InvalidCron } from '../_lib/cron';
import { advanceRun } from '../_lib/executor';
import { gqlAdmin } from '../_lib/hasura';
import { QuotaExhausted, createRun, loadWorkflow } from '../_lib/start-run';

/** A run untouched for this long with no live lease is considered stalled. */
const STALL_AFTER_MS = 2 * 60 * 1000;

/**
 * Hasura Cron Trigger, firing every minute. Does two jobs.
 *
 * 1. Starts scheduled runs. One platform-level cron drives every user-defined
 *    schedule: this reads each active `scheduled` trigger's own cron expression
 *    and starts the ones due this minute. A user editing a schedule in the UI is
 *    a row update, not a Hasura metadata change — which is what makes
 *    per-workflow schedules practical at all.
 *
 * 2. Sweeps stalled runs. A run executes in the background of whichever request
 *    started it, so if that container is replaced mid-run the run is left
 *    `running` with a lease nobody holds. This picks those up once the lease has
 *    lapsed, which is what replaces the self-continuation the serverless version
 *    needed.
 */
export default async function handler(req: Request, res: Response): Promise<void> {
  if (!verifyHasuraSecret(req)) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const now = new Date();
  // Truncate to the minute so a trigger fires at most once per minute even if
  // Hasura delivers the tick twice or a retry arrives late.
  const thisMinute = new Date(now);
  thisMinute.setUTCSeconds(0, 0);

  try {
    const started: { trigger_id: string; run_id: string }[] = [];
    const errors: { trigger_id: string; error: string }[] = [];

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

    for (const trigger of data.workflow_triggers) {
      if (!trigger.cron) continue;

      try {
        if (!cronMatches(trigger.cron, thisMinute)) continue;

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

        const workflow = await loadWorkflow(trigger.workflow_id);
        if (!workflow || workflow.steps.length === 0) continue;

        const { runId } = await createRun({
          workflow,
          triggerType: 'scheduled',
          triggeredBy: null,
          input: { scheduled_for: thisMinute.toISOString(), cron: trigger.cron },
        });
        started.push({ trigger_id: trigger.id, run_id: runId });
        runInBackground(() => advanceRun(runId), `cron:${runId}`);
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

    const swept = await sweepStalledRuns(new Date(now.getTime() - STALL_AFTER_MS));

    res.status(200).json({ at: thisMinute.toISOString(), started, swept, errors });
  } catch (err) {
    console.error('[cron:dispatch]', err);
    res.status(500).json({ message: 'Dispatch failed' });
  }
}

/**
 * Re-advances runs that are still `pending` or `running` but hold no live lease
 * and have not been touched recently. `advanceRun` re-acquires the lease itself,
 * so a run that is actually healthy is skipped rather than double-executed.
 */
async function sweepStalledRuns(staleBefore: Date): Promise<string[]> {
  const data = await gqlAdmin<{ workflow_runs: { id: string }[] }>(
    `query StalledRuns($staleBefore: timestamptz!, $now: timestamptz!) {
       workflow_runs(
         where: {
           status: {_in: ["pending", "running"]},
           updated_at: {_lt: $staleBefore},
           _or: [{locked_until: {_is_null: true}}, {locked_until: {_lt: $now}}]
         },
         order_by: {updated_at: asc},
         limit: 10
       ) { id }
     }`,
    { staleBefore: staleBefore.toISOString(), now: new Date().toISOString() },
  );

  for (const run of data.workflow_runs) {
    runInBackground(() => advanceRun(run.id), `sweep:${run.id}`);
  }
  return data.workflow_runs.map((r) => r.id);
}
