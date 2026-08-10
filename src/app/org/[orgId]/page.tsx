'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppShell, useMyOrgs, useOrgRole } from '@/components/app-shell';
import {
  Button,
  ErrorNote,
  Field,
  Input,
  Label,
  Panel,
  RunStatusChip,
  Spinner,
  STEP_GLYPH,
} from '@/components/ui';
import { CREATE_WORKFLOW, ORG_USAGE, ORG_WORKFLOWS } from '@/lib/gql';
import type { RunStatus, StepType, TriggerType } from '@/lib/types';

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  steps: { id: string; position: number; type: StepType; name: string }[];
  triggers: { id: string; type: TriggerType; is_active: boolean }[];
  runs: { id: string; status: RunStatus; trigger_type: TriggerType; created_at: string }[];
}

export default function OrgPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const role = useOrgRole(orgId);
  const { memberships, loading: orgsLoading } = useMyOrgs();
  const org = memberships.find((m) => m.org.id === orgId)?.org;

  const { data, loading, error, refetch } = useQuery<{ workflows: WorkflowRow[] }>(
    ORG_WORKFLOWS,
    { variables: { orgId } },
  );
  const { data: usageData } = useQuery<{
    org_usage_current_month: {
      runs_this_month: number;
      succeeded_runs: number;
      failed_runs: number;
      paused_runs: number;
      steps_executed: number;
      avg_run_seconds: number | null;
      quota_remaining: number;
    }[];
  }>(ORG_USAGE, { variables: { orgId }, pollInterval: 10_000 });

  const usage = usageData?.org_usage_current_month?.[0];
  const canEdit = role === 'owner' || role === 'editor';

  // Not a member: the queries return empty rather than erroring, so say so
  // plainly instead of rendering a convincing but empty org page.
  if (!orgsLoading && !org) {
    return (
      <AppShell>
        <Panel className="p-8">
          <Label>403</Label>
          <h1 className="mt-2 font-[family-name:var(--font-mono)] text-[18px]">
            No such organization, or you are not a member of it
          </h1>
          <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
            Row-level permissions filter this out at the database, so a valid id belonging to
            another organization is indistinguishable from one that does not exist.
          </p>
          <Link href="/" className="mt-5 inline-block">
            <Button>← back to your organizations</Button>
          </Link>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-6 border-b border-[var(--color-line)] pb-6">
        <div>
          <Label>organization</Label>
          <h1 className="mt-1 font-[family-name:var(--font-mono)] text-[26px] font-bold tracking-[-0.02em]">
            {org?.name ?? '—'}
          </h1>
          <p className="mt-1.5 text-[12px] text-[var(--color-ink-faint)]">
            your role here:{' '}
            <span className="text-[var(--color-amber)]">{role ?? '—'}</span>
            {role === 'viewer' ? ' · read-only, cannot trigger runs' : ''}
          </p>
        </div>

        {usage ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {[
              ['runs this month', usage.runs_this_month],
              ['succeeded', usage.succeeded_runs],
              ['paused', usage.paused_runs],
              ['failed', usage.failed_runs],
              ['steps executed', usage.steps_executed],
              ['avg run', usage.avg_run_seconds ? `${usage.avg_run_seconds}s` : '—'],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt className="font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                  {k}
                </dt>
                <dd className="font-[family-name:var(--font-mono)] text-[18px] leading-tight">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      {canEdit ? <NewWorkflow orgId={orgId} onCreated={() => refetch()} /> : null}

      {loading && !data ? <Spinner label="loading workflows" /> : null}
      {error ? <ErrorNote>{error.message}</ErrorNote> : null}

      <div className="mt-8 space-y-3">
        {(data?.workflows ?? []).map((w, i) => (
          <Link
            key={w.id}
            href={`/org/${orgId}/workflow/${w.id}`}
            className="rise block"
            style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
          >
            <Panel className="group flex flex-wrap items-center gap-x-6 gap-y-3 p-4 transition-colors hover:border-[var(--color-line-bright)]">
              <div className="min-w-[220px] flex-1">
                <h2 className="font-[family-name:var(--font-mono)] text-[15px] text-[var(--color-ink)] transition-colors group-hover:text-[var(--color-amber)]">
                  {w.name}
                </h2>
                {w.description ? (
                  <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
                    {w.description}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5" title={w.steps.map((s) => s.name).join(' → ')}>
                {w.steps.map((s) => (
                  <span
                    key={s.id}
                    className="grid h-7 w-7 place-items-center border border-[var(--color-line-bright)] text-[13px] text-[var(--color-ink-dim)]"
                  >
                    {STEP_GLYPH[s.type] ?? '·'}
                  </span>
                ))}
                {w.steps.length === 0 ? (
                  <span className="text-[11px] text-[var(--color-ink-faint)]">no steps yet</span>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-1">
                {w.triggers.map((t) => (
                  <span
                    key={t.id}
                    className="border border-[var(--color-line)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]"
                  >
                    {t.type}
                  </span>
                ))}
              </div>

              <div className="min-w-[170px] text-right">
                {w.runs[0] ? (
                  <RunStatusChip status={w.runs[0].status} />
                ) : (
                  <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
                    never run
                  </span>
                )}
              </div>
            </Panel>
          </Link>
        ))}
      </div>

      {!loading && (data?.workflows.length ?? 0) === 0 ? (
        <Panel className="mt-8 p-6">
          <p className="text-[13px] text-[var(--color-ink-dim)]">
            No workflows in this organization yet.
            {canEdit ? ' Create one above.' : ' Ask an owner or editor to create one.'}
          </p>
        </Panel>
      ) : null}
    </AppShell>
  );
}

function NewWorkflow({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [create, { loading, error }] = useMutation(CREATE_WORKFLOW);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await create({ variables: { orgId, name, description: description || null } });
    const id = (res.data as { insert_workflows_one?: { id: string } } | null)
      ?.insert_workflows_one?.id;
    setName('');
    setDescription('');
    setOpen(false);
    onCreated();
    if (id) router.push(`/org/${orgId}/workflow/${id}`);
  }

  if (!open) {
    return (
      <div className="mt-6">
        <Button variant="primary" onClick={() => setOpen(true)}>
          + new workflow
        </Button>
      </div>
    );
  }

  return (
    <Panel className="mt-6 p-5">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
        <div className="min-w-[220px] flex-1">
          <Field label="name">
            <Input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Incident triage"
            />
          </Field>
        </div>
        <div className="min-w-[260px] flex-[2]">
          <Field label="description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Classify an inbound alert and escalate if urgent"
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={loading || !name}>
          {loading ? 'creating…' : 'create'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          cancel
        </Button>
      </form>
      {error ? (
        <div className="mt-3">
          <ErrorNote>{error.message}</ErrorNote>
        </div>
      ) : null}
    </Panel>
  );
}
