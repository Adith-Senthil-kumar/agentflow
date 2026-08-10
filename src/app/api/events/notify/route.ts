import { NextResponse } from 'next/server';
import { verifyHasuraSecret } from '@/lib/action-request';
import { gqlAdmin } from '@/lib/hasura';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface EventPayload {
  event: {
    op: string;
    data: { new: Record<string, unknown> | null };
  };
}

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
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json()) as EventPayload;
  const row = body.event?.data?.new;
  if (!row) return NextResponse.json({ skipped: 'no new row' });

  const id = row.id as string;
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  const now = new Date().toISOString();

  let status = 'simulated';
  let response: unknown = {
    simulated: true,
    reason: 'No SLACK_WEBHOOK_URL configured; notification recorded but not sent.',
  };

  if (slackUrl) {
    try {
      const res = await fetch(slackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: [row.subject, row.body].filter(Boolean).join('\n'),
        }),
        cache: 'no-store',
      });
      const text = await res.text();
      status = res.ok ? 'sent' : 'failed';
      response = { http_status: res.status, body: text.slice(0, 500) };

      if (!res.ok) {
        await record(id, status, response, now);
        // Non-2xx from Slack: fail the event so Hasura retries it.
        return NextResponse.json({ message: 'Delivery failed' }, { status: 502 });
      }
    } catch (err) {
      await record(id, 'failed', { error: String(err).slice(0, 500) }, now);
      return NextResponse.json({ message: 'Delivery error' }, { status: 502 });
    }
  }

  await record(id, status, response, now);
  return NextResponse.json({ delivered: status });
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
