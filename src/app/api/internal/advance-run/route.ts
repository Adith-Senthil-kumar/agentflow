import { NextResponse, after } from 'next/server';
import { verifyHasuraSecret } from '@/lib/action-request';
import { advanceRun } from '@/lib/executor';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Continuation endpoint. The executor calls this when it runs out of wall-clock
 * budget, so a long workflow spans several invocations instead of being killed
 * mid-step at the function timeout.
 *
 * Returns 202 straight away and does the work in `after()`, which keeps the
 * caller's request short — otherwise each continuation would block the previous
 * invocation and they would all time out together.
 */
export async function POST(req: Request) {
  if (!verifyHasuraSecret(req)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const { run_id: runId } = (await req.json()) as { run_id?: string };
  if (!runId) return NextResponse.json({ message: 'run_id is required' }, { status: 400 });

  after(() => advanceRun(runId));
  return NextResponse.json({ accepted: true, run_id: runId }, { status: 202 });
}
