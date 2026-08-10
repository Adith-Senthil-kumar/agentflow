/** Failures worth retrying: transport errors, timeouts, 429 and 5xx. */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Failures that will not improve on a second attempt (4xx, bad config). */
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. 2 means "one retry". */
  attempts?: number;
  baseDelayMs?: number;
  /** Invoked before each attempt after the first, so progress is observable. */
  onAttempt?: (attempt: number) => Promise<void> | void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` with exponential backoff. `onAttempt` is awaited before each try so
 * the executor can persist the attempt counter — that is what makes a retry
 * visible in the live subscription rather than something the user only learns
 * about from logs.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { attempts = 2, baseDelayMs = 600, onAttempt }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (onAttempt) await onAttempt(attempt);
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err instanceof PermanentError) throw err;
      if (attempt === attempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RetryableError(`Request timed out after ${timeoutMs}ms`, err);
    }
    throw new RetryableError(
      err instanceof Error ? err.message : 'Network request failed',
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}
