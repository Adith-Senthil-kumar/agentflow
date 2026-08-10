import type { Request, Response } from 'express';
import { verifyHasuraSecret, type HasuraEventPayload } from '../_lib/http';
import { serverEnv } from '../_lib/env';
import { gqlAdmin } from '../_lib/hasura';

/**
 * Hasura Event Trigger: delivers a queued `notifications` row.
 *
 * This is the `notify` step type's actual implementation. Splitting it out of
 * the executor means Slack being slow costs the run nothing, and Hasura's own
 * retry configuration (3 attempts, 10s apart) handles transient delivery
 * failures rather than the executor's per-step retry budget.
 *
 * With no SLACK_WEBHOOK_URL configured, delivery is recorded as `simulated` —
 * the row and its timestamps are real, the outbound POST is not, and the status
 * says so rather than claiming success.
 */
export default async function handler(req: Request, res: Response): Promise<void> {
  if (!verifyHasuraSecret(req)) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const body = req.body as HasuraEventPayload;
  const row = body.event?.data?.new;
  if (!row) {
    res.status(200).json({ skipped: 'no new row' });
    return;
  }

  const id = row['id'] as string;
  const slackUrl = serverEnv.slackWebhookUrl;
  const now = new Date().toISOString();

  if (!slackUrl) {
    await record(id, 'simulated', {
      simulated: true,
      reason: 'No SLACK_WEBHOOK_URL configured; notification recorded but not sent.',
    }, now);
    res.status(200).json({ delivered: 'simulated' });
    return;
  }

  try {
    const upstream = await fetch(slackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: [row['subject'], row['body']].filter(Boolean).join('\n'),
      }),
    });
    const text = await upstream.text();

    if (!upstream.ok) {
      await record(id, 'failed', { http_status: upstream.status, body: text.slice(0, 500) }, now);
      // Non-2xx from Slack: fail the event so Hasura retries it.
      res.status(502).json({ message: 'Delivery failed' });
      return;
    }

    await record(id, 'sent', { http_status: upstream.status, body: text.slice(0, 500) }, now);
    res.status(200).json({ delivered: 'sent' });
  } catch (err) {
    await record(id, 'failed', { error: String(err).slice(0, 500) }, now);
    res.status(502).json({ message: 'Delivery error' });
  }
}

async function record(
  id: string,
  status: string,
  response: unknown,
  now: string,
): Promise<void> {
  await gqlAdmin(
    `mutation RecordDelivery($id: uuid!, $status: String!, $response: jsonb, $now: timestamptz!) {
       update_notifications_by_pk(
         pk_columns: {id: $id},
         _set: {status: $status, delivery_response: $response, sent_at: $now}
       ) { id }
     }`,
    { id, status, response, now },
  );
}
