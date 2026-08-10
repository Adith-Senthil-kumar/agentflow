import type { Request, Response } from 'express';
import { serverEnv } from './env';

export interface HasuraActionPayload<TInput = Record<string, unknown>> {
  action: { name: string };
  input: TInput;
  session_variables: Record<string, string>;
}

export interface HasuraEventPayload {
  event: {
    op: 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';
    data: { new: Record<string, unknown> | null; old: Record<string, unknown> | null };
  };
  table: { schema: string; name: string };
  trigger: { name: string };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Confirms a request actually came from our Hasura instance.
 *
 * Functions are reachable on a public URL, so without this anyone who guessed
 * the path could invoke the executor directly. The secret is configured in
 * Hasura metadata and never leaves the backend.
 */
export function verifyHasuraSecret(req: Request): boolean {
  const provided = req.header('x-agentflow-secret');
  if (!provided) return false;
  return timingSafeEqual(provided, serverEnv.webhookSecret);
}

/** Error shape Hasura surfaces to the GraphQL client. */
export function actionError(
  res: Response,
  message: string,
  status = 400,
  code?: string,
): void {
  res.status(status).json({ message, ...(code ? { extensions: { code } } : {}) });
}

/**
 * The caller's user id, from Hasura's session variables.
 *
 * Trustworthy because Hasura derived it from a JWT it verified itself, and
 * because every Action is declared `forward_client_headers: false` — nothing a
 * browser sends can influence it.
 */
export function sessionUserId(payload: HasuraActionPayload<unknown>): string | null {
  const id = payload.session_variables?.['x-hasura-user-id'];
  return id && id !== 'null' ? id : null;
}

/**
 * Runs background work after the response has been sent.
 *
 * nhost functions execute inside a long-lived Express server rather than a
 * per-invocation sandbox, so a promise started here runs to completion instead
 * of being frozen when the response flushes. That is what lets an Action return
 * a run id immediately while the run continues executing behind it.
 */
export function runInBackground(work: () => Promise<void>, label: string): void {
  void work().catch((err) => {
    console.error(`[background:${label}]`, err);
  });
}
