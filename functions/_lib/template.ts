import type { RunContext } from './types';

/**
 * Resolves a dotted path against the run context, e.g. `last.text` or
 * `steps.Classify.output.choices.0.message.content`. Numeric segments index
 * into arrays.
 */
export function resolvePath(ctx: RunContext, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc)) {
      const i = Number(key);
      return Number.isInteger(i) ? acc[i] : undefined;
    }
    if (typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, ctx);
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Interpolates `{{path}}` references in a string.
 *
 * A template that is exactly one reference (`"{{last.text}}"`) returns the raw
 * value rather than its string form, so a step can pass an object or number
 * through to the next step without it being flattened to JSON text.
 */
export function renderTemplate(input: string, ctx: RunContext): unknown {
  // The path may contain spaces, because `steps` is keyed by step name and
  // step names are human-written ("{{steps.Classify alert.text}}"). Anything
  // that is not a brace is part of the path.
  const soleMatch = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(input.trim());
  if (soleMatch) return resolvePath(ctx, soleMatch[1]);

  return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, path: string) =>
    stringify(resolvePath(ctx, path)),
  );
}

/** Recursively renders every string inside a config value. */
export function renderDeep<T>(value: T, ctx: RunContext): T {
  if (typeof value === 'string') return renderTemplate(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderDeep(v, ctx);
    }
    return out as T;
  }
  return value;
}
