'use client';

import type { ReactNode } from 'react';
import type { RunStatus, StepRunStatus, StepType } from '@/lib/types';

/* --------------------------------------------------------------------------
 * Shared primitives. Kept deliberately small — the console look comes from a
 * handful of consistent rules (1px lines, mono labels, one accent) rather than
 * from a large component library.
 * ------------------------------------------------------------------------ */

export function Panel({
  children,
  className = '',
  as: As = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'aside';
}) {
  return (
    <As className={`border border-[var(--color-line)] bg-[var(--color-panel)] ${className}`}>
      {children}
    </As>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-faint)] ${className}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  type = 'button',
  title,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  const variants: Record<string, string> = {
    primary:
      'bg-[var(--color-amber)] text-black border-[var(--color-amber)] hover:bg-[#ffc23a] font-medium',
    default:
      'bg-[var(--color-panel-2)] text-[var(--color-ink)] border-[var(--color-line-bright)] hover:border-[var(--color-ink-faint)]',
    danger:
      'bg-transparent text-[var(--color-fail)] border-[var(--color-fail)]/40 hover:bg-[var(--color-fail)]/10',
    ghost:
      'bg-transparent text-[var(--color-ink-dim)] border-transparent hover:text-[var(--color-ink)]',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 border px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.1em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-amber)] disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

const inputBase =
  'w-full border border-[var(--color-line-bright)] bg-[var(--color-void)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-amber)] focus:outline-none';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${inputBase} font-[family-name:var(--font-mono)] text-[12px] leading-relaxed ${props.className ?? ''}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

/* ------------------------------- status chips ----------------------------- */

const RUN_STATUS_STYLE: Record<RunStatus, { color: string; label: string }> = {
  pending: { color: 'var(--color-idle)', label: 'queued' },
  running: { color: 'var(--color-live)', label: 'running' },
  paused: { color: 'var(--color-warn)', label: 'paused · awaiting approval' },
  succeeded: { color: 'var(--color-live)', label: 'succeeded' },
  failed: { color: 'var(--color-fail)', label: 'failed' },
  rejected: { color: 'var(--color-fail)', label: 'rejected' },
};

const STEP_STATUS_STYLE: Record<StepRunStatus, { color: string; label: string }> = {
  pending: { color: 'var(--color-idle)', label: 'queued' },
  running: { color: 'var(--color-live)', label: 'running' },
  awaiting_approval: { color: 'var(--color-warn)', label: 'awaiting approval' },
  succeeded: { color: 'var(--color-live)', label: 'succeeded' },
  failed: { color: 'var(--color-fail)', label: 'failed' },
  skipped: { color: 'var(--color-skip)', label: 'skipped by branch' },
  rejected: { color: 'var(--color-fail)', label: 'rejected' },
};

export function RunStatusChip({ status }: { status: RunStatus }) {
  const s = RUN_STATUS_STYLE[status] ?? RUN_STATUS_STYLE.pending;
  const live = status === 'running';
  return (
    <span
      className="inline-flex items-center gap-1.5 border px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.12em]"
      style={{ color: s.color, borderColor: `color-mix(in srgb, ${s.color} 35%, transparent)` }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? 'live-dot' : ''}`}
        style={{ background: s.color }}
      />
      {s.label}
    </span>
  );
}

export function StepStatusChip({ status }: { status: StepRunStatus }) {
  const s = STEP_STATUS_STYLE[status] ?? STEP_STATUS_STYLE.pending;
  const live = status === 'running';
  return (
    <span
      className="inline-flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.12em]"
      style={{ color: s.color }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? 'live-dot' : ''}`}
        style={{ background: s.color }}
      />
      {s.label}
    </span>
  );
}

export const STEP_GLYPH: Record<StepType, string> = {
  llm_call: '◇',
  http_request: '⇄',
  db_write: '▤',
  notify: '◈',
  conditional_branch: '⌥',
  approval_gate: '⏸',
};

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="border border-[var(--color-fail)]/40 bg-[var(--color-fail)]/8 px-3 py-2 text-[12px] leading-relaxed text-[var(--color-fail)]">
      {children}
    </p>
  );
}

export function Spinner({ label = 'loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8">
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--color-amber)]" />
      <Label>{label}</Label>
    </div>
  );
}

export function JsonBlock({ value, max = 420 }: { value: unknown; max?: number }) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="overflow-auto border border-[var(--color-line)] bg-[var(--color-void)] p-2.5 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--color-ink-dim)]"
      style={{ maxHeight: max }}
    >
      {text}
    </pre>
  );
}
