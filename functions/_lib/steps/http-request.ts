import { fetchWithTimeout, PermanentError, RetryableError, withRetry } from '../retry';
import type { HttpRequestConfig } from '../types';
import type { StepExecutor } from './types';

const MAX_BODY_CHARS = 20_000;

/** Generic outbound call to any external API. */
export const executeHttpRequest: StepExecutor = async ({ config, onAttempt }) => {
  const cfg = config as unknown as HttpRequestConfig;

  if (!cfg.url || typeof cfg.url !== 'string') {
    throw new PermanentError('http_request requires a `url` in its config');
  }
  let parsed: URL;
  try {
    parsed = new URL(cfg.url);
  } catch {
    throw new PermanentError(`http_request has an invalid url: ${cfg.url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PermanentError(`http_request only supports http(s), got ${parsed.protocol}`);
  }

  const method = (cfg.method ?? 'GET').toUpperCase();
  const timeout = Math.min(cfg.timeout_ms ?? 15_000, 25_000);
  const sendsBody = method !== 'GET' && method !== 'DELETE' && cfg.body !== undefined;

  const output = await withRetry(
    async () => {
      const res = await fetchWithTimeout(
        cfg.url,
        {
          method,
          headers: {
            accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
            ...(sendsBody ? { 'content-type': 'application/json' } : {}),
            ...(cfg.headers ?? {}),
          },
          ...(sendsBody
            ? {
                body:
                  typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body),
              }
            : {}),
        },
        timeout,
      );

      const raw = await res.text();
      if (!res.ok) {
        const message = `${method} ${cfg.url} returned ${res.status}: ${raw.slice(0, 300)}`;
        if (res.status === 429 || res.status >= 500) throw new RetryableError(message);
        throw new PermanentError(message);
      }

      // Truncate rather than store an unbounded response — a step_run row ends up
      // in every subscription payload for the run.
      const truncated = raw.length > MAX_BODY_CHARS;
      const text = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;

      let body: unknown = text;
      const contentType = res.headers.get('content-type') ?? '';
      if (!truncated && contentType.includes('json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      return {
        status: res.status,
        ok: res.ok,
        content_type: contentType || null,
        truncated,
        body,
      };
    },
    { attempts: 2, baseDelayMs: 700, onAttempt },
  );

  return { output };
};
