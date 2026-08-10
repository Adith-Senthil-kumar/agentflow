import 'server-only';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Server-side configuration. Importing this module from a client component is a
 * build error (`server-only`), which is the guard that keeps the admin secret
 * out of the browser bundle.
 */
export const serverEnv = {
  get hasuraUrl() {
    return required('HASURA_GRAPHQL_URL');
  },
  get hasuraAdminSecret() {
    return required('HASURA_GRAPHQL_ADMIN_SECRET');
  },
  /** Shared secret Hasura presents on every Action / Event / Cron invocation. */
  get webhookSecret() {
    return required('AGENTFLOW_WEBHOOK_SECRET');
  },
  /** Public origin of this app; used for the executor's own continuation calls. */
  get appBaseUrl() {
    return (
      process.env.ACTION_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
      'http://localhost:3000'
    );
  },
  get groqApiKey() {
    return process.env.GROQ_API_KEY || '';
  },
  get groqModel() {
    return optional('GROQ_MODEL', 'llama-3.3-70b-versatile');
  },
  /**
   * When no LLM key is configured the llm_call step falls back to a stub with a
   * disclosed artificial delay, and every step output is flagged `stubbed: true`
   * so a reviewer can never mistake it for a real completion.
   */
  get llmStubbed() {
    return !process.env.GROQ_API_KEY;
  },
};

export const publicEnv = {
  nhostSubdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || '',
  nhostRegion: process.env.NEXT_PUBLIC_NHOST_REGION || '',
};
