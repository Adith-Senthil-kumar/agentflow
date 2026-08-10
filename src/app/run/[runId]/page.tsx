'use client';

import { useMutation, useSubscription } from '@apollo/client/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AppShell, useOrgRole } from '@/components/app-shell';
import {
  Button,
  ErrorNote,
  Input,
  JsonBlock,
  Label,
  Panel,
  RunStatusChip,
  Spinner,
  StepStatusChip,
  STEP_GLYPH,
} from '@/components/ui';
import { APPROVE_STEP, RUN_SUB, STEP_RUNS_SUB } from '@/lib/gql';
import type { RunStatus, StepRunStatus, StepType } from '@/lib/types';

interface StepRunRow {
  id: string;
  position: number;
  type: StepType;
  name: string;
  status: StepRunStatus;
  output: unknown;
  error: string | null;
  attempt: number;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  approver: { id: string; displayName: string | null } | null;
}

interface RunRow {
  id: string;
  status: RunStatus;
  error: string | null;
  cursor: number;
  trigger_type: string;
  started_at: string | null;
  finished_at: string | null;
  context: Record<string, unknown>;
  workflow: { id: string; name: string; org_id: string };
}

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();

  // Two subscriptions: one for the run header, one for the step timeline. Both
  // are permission-filtered server-side, so an id from another org yields a
  // stream that is simply always empty.
  const { data: runData, loading: runLoading } = useSubscription<{
    workflow_runs_by_pk: RunRow | null;
  }>(RUN_SUB, { variables: { runId } });

  const { data: stepData } = useSubscription<{ step_runs: StepRunRow[] }>(STEP_RUNS_SUB, {
    variables: { runId },
  });

  const run = runData?.workflow_runs_by_pk ?? null;
  const steps = stepData?.step_runs ?? [];
  const role = useOrgRole(run?.workflow.org_id);

  if (runLoading && !runData) {
    return (
      <AppShell>
        <Spinner label="connecting to live run" />
      </AppShell>
    );
  }

  if (!run) {
    return (
      <AppShell>
        <Panel className="p-8">
          <Label>403</Label>
          <h1 className="mt-2 font-[family-name:var(--font-mono)] text-[18px]">
            No such run, or it belongs to another organization
          </h1>
          <p className="mt-3 max-w-[64ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
            This page holds an open subscription for this exact run id. Because the row
            permission on <code>workflow_runs</code> and <code>step_runs</code> resolves through{' '}
            <code>org_members</code>, a run from another organization produces an empty stream
            rather than an authorization error — there is nothing here to confirm or deny.
          </p>
          <Link href="/" className="mt-5 inline-block">
            <Button>← your organizations</Button>
          </Link>
        </Panel>
      </AppShell>
    );
  }

  const elapsed = run.started_at
    ? ((run.finished_at ? new Date(run.finished_at).getTime() : Date.now()) -
        new Date(run.started_at).getTime()) /
      1000
    : null;

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-6 border-b border-[var(--color-line)] pb-6">
        <div>
          <Link
            href={`/org/${run.workflow.org_id}/workflow/${run.workflow.id}`}
            className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-amber)]"
          >
            ← {run.workflow.name}
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-mono)] text-[22px] font-bold tracking-[-0.02em]">
            Run {run.id.slice(0, 8)}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <RunStatusChip status={run.status} />
            <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-faint)]">
              via {run.trigger_type}
              {elapsed !== null ? ` · ${elapsed.toFixed(1)}s` : ''}
            </span>
          </div>
        </div>

        <div className="text-right">
          <Label>live</Label>
          <p className="mt-1 max-w-[30ch] text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
            Streaming over a GraphQL subscription on <code>step_runs</code>. Nothing on this page
            polls or refreshes.
          </p>
        </div>
      </div>

      {run.error ? (
        <div className="mt-6">
          <ErrorNote>{run.error}</ErrorNote>
        </div>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <ol className="relative space-y-2">
            {/* connector rail */}
            <span
              className="pointer-events-none absolute top-4 bottom-4 left-[19px] w-px bg-[var(--color-line)]"
              aria-hidden
            />
            {steps.map((s) => (
              <StepRunCard key={s.id} step={s} role={role} runStatus={run.status} />
            ))}
          </ol>
          {steps.length === 0 ? <Spinner label="waiting for steps" /> : null}
        </section>

        <aside className="space-y-6">
          <Panel className="p-4">
            <h2 className="font-[family-name:var(--font-mono)] text-[12px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">
              Run context
            </h2>
            <p className="mt-2 mb-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              Accumulated as steps complete. <code>last</code> is what{' '}
              <code>{'{{last.text}}'}</code> resolves to in the next step.
            </p>
            <JsonBlock value={run.context} max={480} />
          </Panel>
        </aside>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function StepRunCard({
  step,
  role,
  runStatus,
}: {
  step: StepRunRow;
  role: string | null;
  runStatus: RunStatus;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [approve, { loading, error }] = useMutation(APPROVE_STEP);

  const awaiting = step.status === 'awaiting_approval' && runStatus === 'paused';
  const allowedRoles =
    (step.output as { allowed_roles?: string[] } | null)?.allowed_roles ?? ['owner', 'editor'];
  const canApprove = awaiting && !!role && allowedRoles.includes(role);

  const running = step.status === 'running';
  const duration =
    step.started_at && step.finished_at
      ? (new Date(step.finished_at).getTime() - new Date(step.started_at).getTime()) / 1000
      : null;

  const accent =
    step.status === 'failed' || step.status === 'rejected'
      ? 'var(--color-fail)'
      : step.status === 'awaiting_approval'
        ? 'var(--color-warn)'
        : step.status === 'succeeded'
          ? 'var(--color-live)'
          : step.status === 'skipped'
            ? 'var(--color-skip)'
            : 'var(--color-idle)';

  return (
    <li className="rise relative">
      <Panel
        className={`relative overflow-hidden ${running ? 'sweep' : ''}`}
        as="div"
      >
        <div className="flex items-start gap-3 p-3">
          <span
            className="relative z-10 mt-0.5 grid h-8 w-8 shrink-0 place-items-center border bg-[var(--color-void)] text-[13px]"
            style={{ borderColor: accent, color: accent }}
          >
            {STEP_GLYPH[step.type] ?? '·'}
          </span>

          <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={`font-[family-name:var(--font-mono)] text-[13px] ${
                  step.status === 'skipped'
                    ? 'text-[var(--color-ink-faint)] line-through'
                    : 'text-[var(--color-ink)]'
                }`}
              >
                {step.position}. {step.name}
              </span>
              <StepStatusChip status={step.status} />
              {step.attempt > 1 ? (
                <span
                  className="border border-[var(--color-warn)]/40 px-1.5 py-px font-[family-name:var(--font-mono)] text-[9px] tracking-[0.1em] text-[var(--color-warn)] uppercase"
                  title="This step failed and was retried"
                >
                  attempt {step.attempt}
                </span>
              ) : null}
              {duration !== null ? (
                <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                  {duration.toFixed(2)}s
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 font-[family-name:var(--font-mono)] text-[10px] tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
              {step.type}
              {step.approver
                ? ` · approved by ${step.approver.displayName ?? step.approver.id.slice(0, 8)}`
                : ''}
            </div>
          </button>

          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? '−' : '+'}
          </Button>
        </div>

        {/* Approval gate: the one place the UI can change a run's course. */}
        {awaiting ? (
          <div className="border-t border-[var(--color-warn)]/30 bg-[var(--color-warn)]/6 p-4">
            <p className="text-[12px] leading-relaxed text-[var(--color-warn)]">
              {(step.output as { instructions?: string } | null)?.instructions ??
                'This run is paused and needs approval to continue.'}
            </p>
            <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
              Allowed roles: {allowedRoles.join(', ')} · your role in this org: {role ?? 'none'}
            </p>

            {canApprove ? (
              <div className="mt-3 space-y-2">
                <Input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="optional comment"
                />
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={loading}
                    onClick={() =>
                      approve({
                        variables: { stepRunId: step.id, decision: 'approve', comment },
                      })
                    }
                  >
                    {loading ? 'submitting…' : '✓ approve & resume'}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={loading}
                    onClick={() =>
                      approve({
                        variables: { stepRunId: step.id, decision: 'reject', comment },
                      })
                    }
                  >
                    ✕ reject
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-3 border border-[var(--color-line-bright)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-ink-dim)]">
                You cannot approve this step. The <code>approveStep</code> handler re-checks your
                role in this organization before it will resume the run, so hiding these buttons
                is presentation only — calling the mutation directly returns the same refusal.
              </p>
            )}

            {error ? (
              <div className="mt-3">
                <ErrorNote>{error.message}</ErrorNote>
              </div>
            ) : null}
          </div>
        ) : null}

        {open ? (
          <div className="space-y-3 border-t border-[var(--color-line)] bg-[var(--color-panel-2)] p-4">
            {step.error ? (
              <div>
                <Label>error</Label>
                <div className="mt-1.5">
                  <ErrorNote>{step.error}</ErrorNote>
                </div>
              </div>
            ) : null}
            <div>
              <Label>output</Label>
              <div className="mt-1.5">
                {step.output ? (
                  <JsonBlock value={step.output} />
                ) : (
                  <p className="text-[12px] text-[var(--color-ink-faint)]">
                    {step.status === 'pending'
                      ? 'Not started yet.'
                      : step.status === 'skipped'
                        ? 'Skipped by a conditional branch.'
                        : 'No output.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </Panel>
    </li>
  );
}
