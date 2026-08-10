'use client';

import { useState } from 'react';
import { Field, Input, Select, Textarea } from './ui';
import type { StepType } from '@/lib/types';

/* --------------------------------------------------------------------------
 * Typed config forms, one per step type. Each writes a plain JSON object into
 * workflow_steps.config, so adding a step type is a form plus an executor and
 * a row in step_types — no schema change.
 *
 * `{{path}}` references anywhere in a config are resolved against the run
 * context at execution time. `{{last.text}}` is the previous step's output.
 * ------------------------------------------------------------------------ */

export const DEFAULT_CONFIG: Record<StepType, Record<string, unknown>> = {
  llm_call: {
    system: 'You are a precise triage assistant. Answer in one short line.',
    prompt:
      'Classify the following alert as URGENT or NORMAL and explain in one sentence:\n\n{{trigger.subject}}',
    temperature: 0.2,
    max_tokens: 200,
  },
  http_request: {
    method: 'GET',
    url: 'https://api.github.com/repos/hasura/graphql-engine',
    timeout_ms: 15000,
  },
  db_write: {
    key: 'triage_result',
    value: '{{last.text}}',
  },
  notify: {
    channel: 'slack',
    subject: 'Workflow alert',
    body: 'Triage says: {{last.text}}',
  },
  conditional_branch: {
    left: '{{steps.Classify alert.text}}',
    operator: 'contains',
    right: 'URGENT',
    on_true: { action: 'continue' },
    on_false: { action: 'end' },
  },
  approval_gate: {
    instructions: 'An owner or editor must approve before this run continues.',
    allowed_roles: ['owner', 'editor'],
  },
};

export function StepConfigForm({
  type,
  config,
  onChange,
  stepNames,
}: {
  type: StepType;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  stepNames: string[];
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const str = (k: string, fallback = '') => (config[k] as string) ?? fallback;
  const num = (k: string, fallback: number) =>
    typeof config[k] === 'number' ? (config[k] as number) : fallback;

  if (type === 'llm_call') {
    return (
      <div className="space-y-3">
        <Field label="system prompt">
          <Textarea rows={2} value={str('system')} onChange={(e) => set({ system: e.target.value })} />
        </Field>
        <Field
          label="prompt"
          hint="Supports {{trigger.*}}, {{last.*}} and {{steps.<step name>.*}} references."
        >
          <Textarea rows={4} value={str('prompt')} onChange={(e) => set({ prompt: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="temperature">
            <Input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={num('temperature', 0.2)}
              onChange={(e) => set({ temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label="max tokens">
            <Input
              type="number"
              min="1"
              max="4096"
              value={num('max_tokens', 200)}
              onChange={(e) => set({ max_tokens: Number(e.target.value) })}
            />
          </Field>
        </div>
      </div>
    );
  }

  if (type === 'http_request') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-[110px_1fr] gap-3">
          <Field label="method">
            <Select value={str('method', 'GET')} onChange={(e) => set({ method: e.target.value })}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="url">
            <Input value={str('url')} onChange={(e) => set({ url: e.target.value })} />
          </Field>
        </div>
        <Field label="body (json)" hint="Ignored for GET and DELETE.">
          <Textarea
            rows={3}
            value={
              config.body === undefined
                ? ''
                : typeof config.body === 'string'
                  ? config.body
                  : JSON.stringify(config.body, null, 2)
            }
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw.trim()) return set({ body: undefined });
              try {
                set({ body: JSON.parse(raw) });
              } catch {
                set({ body: raw });
              }
            }}
          />
        </Field>
        <Field label="timeout (ms)">
          <Input
            type="number"
            min="1000"
            max="25000"
            value={num('timeout_ms', 15000)}
            onChange={(e) => set({ timeout_ms: Number(e.target.value) })}
          />
        </Field>
      </div>
    );
  }

  if (type === 'db_write') {
    return (
      <div className="space-y-3">
        <Field label="key" hint="Stored on step_outputs, scoped to this run's organization.">
          <Input value={str('key')} onChange={(e) => set({ key: e.target.value })} />
        </Field>
        <Field label="value">
          <Textarea
            rows={3}
            value={
              typeof config.value === 'string'
                ? config.value
                : JSON.stringify(config.value ?? '', null, 2)
            }
            onChange={(e) => set({ value: e.target.value })}
          />
        </Field>
      </div>
    );
  }

  if (type === 'notify') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="channel">
            <Select value={str('channel', 'slack')} onChange={(e) => set({ channel: e.target.value })}>
              <option value="slack">slack</option>
              <option value="email">email</option>
            </Select>
          </Field>
          <Field label="target">
            <Input
              value={str('target')}
              placeholder="#incidents"
              onChange={(e) => set({ target: e.target.value })}
            />
          </Field>
        </div>
        <Field label="subject">
          <Input value={str('subject')} onChange={(e) => set({ subject: e.target.value })} />
        </Field>
        <Field label="body" hint="Delivered by a Hasura Event Trigger, not by the executor.">
          <Textarea rows={3} value={str('body')} onChange={(e) => set({ body: e.target.value })} />
        </Field>
      </div>
    );
  }

  if (type === 'conditional_branch') {
    const branch = (key: 'on_true' | 'on_false') =>
      (config[key] as { action?: string; position?: number }) ?? { action: 'continue' };

    return (
      <div className="space-y-3">
        <Field
          label="left"
          hint={
            stepNames.length
              ? `Available: ${stepNames.map((n) => `{{steps.${n}.text}}`).join('  ')}`
              : undefined
          }
        >
          <Input value={str('left')} onChange={(e) => set({ left: e.target.value })} />
        </Field>
        <div className="grid grid-cols-[150px_1fr] gap-3">
          <Field label="operator">
            <Select value={str('operator', 'contains')} onChange={(e) => set({ operator: e.target.value })}>
              {[
                'contains',
                'not_contains',
                'equals',
                'not_equals',
                'gt',
                'lt',
                'matches',
                'is_empty',
                'is_not_empty',
              ].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </Select>
          </Field>
          <Field label="right">
            <Input value={str('right')} onChange={(e) => set({ right: e.target.value })} />
          </Field>
        </div>
        {(['on_true', 'on_false'] as const).map((key) => (
          <div key={key} className="grid grid-cols-[150px_1fr] gap-3">
            <Field label={key.replace('_', ' ')}>
              <Select
                value={branch(key).action ?? 'continue'}
                onChange={(e) =>
                  set({
                    [key]:
                      e.target.value === 'goto'
                        ? { action: 'goto', position: branch(key).position ?? 0 }
                        : { action: e.target.value },
                  })
                }
              >
                <option value="continue">continue</option>
                <option value="goto">jump to step</option>
                <option value="end">end run</option>
              </Select>
            </Field>
            {branch(key).action === 'goto' ? (
              <Field label="target position" hint="Forward jumps only; a backward jump is rejected.">
                <Input
                  type="number"
                  min="0"
                  value={branch(key).position ?? 0}
                  onChange={(e) =>
                    set({ [key]: { action: 'goto', position: Number(e.target.value) } })
                  }
                />
              </Field>
            ) : (
              <div />
            )}
          </div>
        ))}
      </div>
    );
  }

  // approval_gate
  const roles = (config.allowed_roles as string[]) ?? ['owner', 'editor'];
  return (
    <div className="space-y-3">
      <Field label="instructions">
        <Textarea
          rows={2}
          value={str('instructions')}
          onChange={(e) => set({ instructions: e.target.value })}
        />
      </Field>
      <Field
        label="roles that may approve"
        hint="Checked by the approveStep handler at approval time, against the caller's role in this org."
      >
        <div className="flex gap-2">
          {(['owner', 'editor', 'viewer'] as const).map((r) => {
            const on = roles.includes(r);
            return (
              <button
                key={r}
                type="button"
                onClick={() =>
                  set({
                    allowed_roles: on ? roles.filter((x) => x !== r) : [...roles, r],
                  })
                }
                className={`border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
                  on
                    ? 'border-[var(--color-amber)] text-[var(--color-amber)]'
                    : 'border-[var(--color-line)] text-[var(--color-ink-faint)]'
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

export function useDraft<T>(initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  return {
    value,
    dirty,
    set: (next: T) => {
      setValue(next);
      setDirty(true);
    },
    reset: (next: T) => {
      setValue(next);
      setDirty(false);
    },
  };
}
