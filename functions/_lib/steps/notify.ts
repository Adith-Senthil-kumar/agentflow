import { gqlAdmin } from '../hasura';
import { PermanentError } from '../retry';
import type { NotifyConfig } from '../types';
import type { StepExecutor } from './types';

/**
 * Slack/email alert, implemented as an Event Trigger.
 *
 * The step itself only inserts a `notifications` row. Hasura's Event Trigger on
 * that table then POSTs to /api/events/notify, which does the delivery with
 * Hasura's own retry policy. Two things follow from that split: a slow or
 * failing Slack webhook cannot stall or fail the workflow run, and delivery is
 * retried by infrastructure rather than by the executor holding a connection
 * open inside a serverless function.
 */
export const executeNotify: StepExecutor = async ({ config, run, stepRunId, onAttempt }) => {
  const cfg = config as unknown as NotifyConfig;

  if (!cfg.body || typeof cfg.body !== 'string') {
    throw new PermanentError('notify requires a `body` in its config');
  }

  await onAttempt(1);

  const data = await gqlAdmin<{ insert_notifications_one: { id: string } }>(
    `mutation QueueNotification($object: notifications_insert_input!) {
       insert_notifications_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: run.org_id,
        workflow_run_id: run.id,
        step_run_id: stepRunId,
        channel: cfg.channel ?? 'slack',
        target: cfg.target ?? null,
        subject: cfg.subject ?? null,
        body: cfg.body,
      },
    },
  );

  return {
    output: {
      queued: true,
      notification_id: data.insert_notifications_one.id,
      channel: cfg.channel ?? 'slack',
      delivered_by: 'hasura_event_trigger',
    },
  };
};
