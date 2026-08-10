import 'server-only';
import { NextResponse } from 'next/server';
import { serverEnv } from './env';

export interface HasuraActionPayload<TInput = Record<string, unknown>> {
  action: { name: string };
  input: TInput;
  session_variables: Record<string, string>;
  request_query?: string;
}

/**
 * Error shape Hasura understands. Returning 400 with `message` surfaces it to
 * the GraphQL client as a normal error entry.
 */
export function actionError(message: string, status = 400, code?: string) {
  return NextResponse.json(
    { message, extensions: code ? { code } : undefined },
    { status },
  );
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
 * Actions and Event Triggers are plain HTTP endpoints on a public origin, so
 * without this anyone who guessed the path could invoke the executor directly.
 * The secret is configured in Hasura metadata and never leaves the server.
 */
export function verifyHasuraSecret(req: Request): boolean {
  const provided = req.headers.get('x-agentflow-secret');
  if (!provided) return false;
  return timingSafeEqual(provided, serverEnv.webhookSecret);
}

/**
 * The caller's user id, taken from Hasura's session variables.
 *
 * This is trustworthy because Hasura derived it from a JWT it verified itself,
 * and because every Action is declared with `forward_client_headers: false` —
 * so nothing a browser sends can influence it.
 */
export function sessionUserId(
  payload: HasuraActionPayload<unknown>,
): string | null {
  const id = payload.session_variables?.['x-hasura-user-id'];
  return id && id !== 'null' ? id : null;
}
