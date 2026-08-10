import { serverEnv } from '../env';
import { fetchWithTimeout, PermanentError, RetryableError, withRetry } from '../retry';
import type { LlmCallConfig } from '../types';
import type { StepExecutor } from './types';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const STUB_DELAY_MS = 900;

/**
 * Calls a real LLM (Groq's OpenAI-compatible chat completions endpoint).
 *
 * With no GROQ_API_KEY configured this degrades to a stub that waits
 * STUB_DELAY_MS and returns a deterministic classification. The stub always
 * sets `stubbed: true` on its output and says so in the text, so a stubbed run
 * is never mistaken for a real one in the UI or in a recording.
 */
export const executeLlmCall: StepExecutor = async ({ config, onAttempt }) => {
  const cfg = config as unknown as LlmCallConfig;

  if (!cfg.prompt || typeof cfg.prompt !== 'string') {
    throw new PermanentError('llm_call requires a `prompt` in its config');
  }

  if (serverEnv.llmStubbed) {
    await onAttempt(1);
    await new Promise((r) => setTimeout(r, STUB_DELAY_MS));
    const text = stubCompletion(cfg.prompt);
    return {
      output: {
        text,
        model: 'stub',
        stubbed: true,
        note: `No GROQ_API_KEY configured; stubbed response after a disclosed ${STUB_DELAY_MS}ms delay.`,
      },
    };
  }

  const model = cfg.model || serverEnv.groqModel;
  const messages = [
    ...(cfg.system ? [{ role: 'system' as const, content: cfg.system }] : []),
    { role: 'user' as const, content: cfg.prompt },
  ];

  const output = await withRetry(
    async () => {
      const res = await fetchWithTimeout(
        GROQ_URL,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${serverEnv.groqApiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: cfg.temperature ?? 0.2,
            max_tokens: cfg.max_tokens ?? 512,
          }),
        },
        20_000,
      );

      const body = await res.text();
      if (!res.ok) {
        // 429 and 5xx are worth another attempt; a 400 means the request itself
        // is wrong and retrying just burns quota.
        const message = `Groq returned ${res.status}: ${body.slice(0, 400)}`;
        if (res.status === 429 || res.status >= 500) throw new RetryableError(message);
        throw new PermanentError(message);
      }

      const json = JSON.parse(body) as {
        choices?: { message?: { content?: string } }[];
        usage?: Record<string, number>;
        model?: string;
      };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new RetryableError('Groq returned no completion text');

      return { text, model: json.model ?? model, usage: json.usage ?? null, stubbed: false };
    },
    { attempts: 2, baseDelayMs: 800, onAttempt },
  );

  return { output };
};

/**
 * Deterministic stand-in that still exercises the branch logic downstream:
 * it echoes an URGENT/NORMAL verdict based on a keyword scan of the prompt.
 */
function stubCompletion(prompt: string): string {
  const urgent = /\b(urgent|outage|down|critical|asap|breach|escalat)/i.test(prompt);
  return urgent
    ? 'URGENT — [stubbed LLM response] The input describes a time-sensitive problem that needs immediate attention.'
    : 'NORMAL — [stubbed LLM response] The input describes a routine request with no time pressure.';
}
