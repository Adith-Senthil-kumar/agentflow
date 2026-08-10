import { serverEnv } from './env';

export class HasuraError extends Error {
  constructor(
    message: string,
    readonly errors: unknown,
  ) {
    super(message);
    this.name = 'HasuraError';
  }
}

/**
 * Admin-privileged GraphQL client. Every caller of this bypasses row
 * permissions, so a handler must do its own authorisation *before* reaching for
 * it — see assertOrgRole in org-access.ts.
 */
export async function gqlAdmin<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(serverEnv.hasuraUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': serverEnv.hasuraAdminSecret,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new HasuraError(
      `Hasura returned errors: ${JSON.stringify(json.errors)}`,
      json.errors,
    );
  }
  if (!res.ok) {
    throw new HasuraError(`Hasura HTTP ${res.status}`, null);
  }
  return json.data as T;
}
