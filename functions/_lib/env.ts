/**
 * Configuration for the nhost serverless functions.
 *
 * nhost injects a set of NHOST_* variables into every function, so the Hasura
 * URL and admin secret need no manual setup. Only the two values nhost cannot
 * know — the LLM key and the shared webhook secret — have to be added as
 * project environment variables.
 */

function fromNhostService(service: string): string {
  const subdomain = process.env['NHOST_SUBDOMAIN'];
  const region = process.env['NHOST_REGION'];
  if (!subdomain || !region) return '';
  return `https://${subdomain}.${service}.${region}.nhost.run/v1`;
}

export const serverEnv = {
  get hasuraUrl(): string {
    const url =
      process.env['NHOST_GRAPHQL_URL'] ||
      process.env['HASURA_GRAPHQL_URL'] ||
      (fromNhostService('hasura') ? `${fromNhostService('hasura')}/graphql` : '');
    if (!url) throw new Error('Cannot resolve the Hasura GraphQL URL');
    return url;
  },

  get hasuraAdminSecret(): string {
    const secret =
      process.env['NHOST_ADMIN_SECRET'] || process.env['HASURA_GRAPHQL_ADMIN_SECRET'];
    if (!secret) throw new Error('Cannot resolve the Hasura admin secret');
    return secret;
  },

  /**
   * Shared secret Hasura presents on every Action, Event and Cron invocation.
   *
   * Prefers our own explicit variable so the value in Hasura's metadata and the
   * value the function checks come from one place; falls back to the secret
   * nhost injects into both services by default.
   */
  get webhookSecret(): string {
    const secret =
      process.env['AGENTFLOW_WEBHOOK_SECRET'] || process.env['NHOST_WEBHOOK_SECRET'];
    if (!secret) throw new Error('Cannot resolve the webhook secret');
    return secret;
  },

  get groqApiKey(): string {
    return process.env['GROQ_API_KEY'] || '';
  },

  get groqModel(): string {
    return process.env['GROQ_MODEL'] || 'llama-3.3-70b-versatile';
  },

  /**
   * With no LLM key the llm_call step degrades to a stub with a disclosed
   * delay, and flags every output `stubbed: true`.
   */
  get llmStubbed(): boolean {
    return !process.env['GROQ_API_KEY'];
  },

  get slackWebhookUrl(): string {
    return process.env['SLACK_WEBHOOK_URL'] || '';
  },
};
