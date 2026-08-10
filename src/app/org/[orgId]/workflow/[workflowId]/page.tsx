'use client';

import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppShell, useOrgRole } from '@/components/app-shell';
import { DEFAULT_CONFIG, StepConfigForm } from '@/components/step-editor';
import {
  Button,
  ErrorNote,
  Field,
  Input,
  JsonBlock,
  Label,
  Panel,
  RunStatusChip,
  Select,
  Spinner,
  STEP_GLYPH,
} from '@/components/ui';
import {
  ADD_STEP,
  ADD_TRIGGER,
  DELETE_STEP,
  DELETE_TRIGGER,
  GET_WEBHOOK_ENDPOINT,
  INSERT_WATCHED_RECORD,
  STEP_TYPES,
  SWAP_STEPS,
  TRIGGER_WORKFLOW_RUN,
  UPDATE_STEP,
  WORKFLOW_DETAIL,
  WORKFLOW_RUNS_SUB,
} from '@/lib/gql';
import type { OrgRole, RunStatus, StepType, TriggerType } from '@/lib/types';

interface StepRow {
  id: string;
  position: number;
  type: StepType;
  name: string;
  config: Record<string, unknown>;
}
interface TriggerRow {
  id: string;
  type: TriggerType;
  config: Record<string, unknown>;
  cron: string | null;
  is_active: boolean;
  last_fired_at: string | null;
}
interface RunRow {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  triggered_by_user: { id: string; displayName: string | null } | null;
}
interface WorkflowDetail {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  steps: StepRow[];
  triggers: TriggerRow[];
  runs: RunRow[];
}

export default function WorkflowPage() {
  const { orgId, workflowId } = useParams<{ orgId: string; workflowId: string }>();
  const router = useRouter();
  const role = useOrgRole(orgId);

  const { data, loading, refetch } = useQuery<{
    workflows_by_pk: WorkflowDetail | null;
  }>(WORKFLOW_DETAIL, { variables: { workflowId } });

  const { data: typeData } = useQuery<{
    step_types: { value: StepType; description: string; owner_only: boolean }[];
    trigger_types: { value: TriggerType; description: string; owner_only: boolean }[];
  }>(STEP_TYPES);

  // Live, so a run started by webhook / cron / database event shows up here
  // without anyone touching the page.
  const { data: liveRuns } = useSubscription<{ workflow_runs: RunRow[] }>(WORKFLOW_RUNS_SUB, {
    variables: { workflowId },
  });

  const [runWorkflow, { loading: running, error: runError }] = useMutation(TRIGGER_WORKFLOW_RUN);
  const [runNotice, setRunNotice] = useState<string | null>(null);

  const workflow = data?.workflows_by_pk;
  const runs = liveRuns?.workflow_runs ?? workflow?.runs ?? [];

  const canEdit = role === 'owner' || role === 'editor';
  const isOwner = role === 'owner';

  const ownerOnlyTypes = new Set(
    (typeData?.step_types ?? []).filter((t) => t.owner_only).map((t) => t.value),
  );

  // Owners and editors may trigger runs; viewers may not. The Run button is
  // hidden for anyone who cannot use it, and the triggerWorkflowRun handler
  // refuses them independently — hiding it is presentation, not the control.
  const canRun = role === 'owner' || role === 'editor';

  async function startRun() {
    setRunNotice(null);
    try {
      const res = await runWorkflow({
        variables: {
          workflowId,
          input: { subject: 'Production database is down', source: 'manual' },
        },
      });
      const runId = (
        res.data as { triggerWorkflowRun?: { run_id: string } } | null
      )?.triggerWorkflowRun?.run_id;
      if (runId) router.push(`/run/${runId}`);
    } catch {
      /* surfaced through runError */
    }
  }

  if (loading && !data) {
    return (
      <AppShell>
        <Spinner label="loading workflow" />
      </AppShell>
    );
  }

  if (!workflow) {
    return (
      <AppShell>
        <Panel className="p-8">
          <Label>403</Label>
          <h1 className="mt-2 font-[family-name:var(--font-mono)] text-[18px]">
            No such workflow, or it belongs to another organization
          </h1>
          <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
            The row permission on <code>workflows</code> walks to{' '}
            <code>org_members</code> for the signed-in user, so a workflow id from another org
            simply returns no row.
          </p>
          <Link href={`/org/${orgId}`} className="mt-5 inline-block">
            <Button>← back</Button>
          </Link>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-6 border-b border-[var(--color-line)] pb-6">
        <div className="min-w-[280px]">
          <Link
            href={`/org/${orgId}`}
            className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-amber)]"
          >
            ← workflows
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-mono)] text-[24px] font-bold tracking-[-0.02em]">
            {workflow.name}
          </h1>
          {workflow.description ? (
            <p className="mt-1.5 max-w-[70ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
              {workflow.description}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col items-end gap-2">
          {canRun ? (
            <Button
              variant="primary"
              onClick={startRun}
              disabled={running || workflow.steps.length === 0}
            >
              {running ? 'starting…' : '▶ run workflow'}
            </Button>
          ) : null}
          {runError ? <ErrorNote>{runError.message}</ErrorNote> : null}
          {runNotice ? (
            <p className="text-[11px] text-[var(--color-live)]">{runNotice}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-mono)] text-[13px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">
              Steps
            </h2>
            <Label>{workflow.steps.length} total</Label>
          </div>

          <div className="space-y-2">
            {workflow.steps.map((step, i) => (
              <StepCard
                key={step.id}
                step={step}
                index={i}
                total={workflow.steps.length}
                canEdit={canEdit}
                isOwner={isOwner}
                ownerOnly={ownerOnlyTypes.has(step.type)}
                stepNames={workflow.steps.map((s) => s.name)}
                neighbours={workflow.steps}
                onChanged={refetch}
              />
            ))}
          </div>

          {canEdit ? (
            <AddStep
              workflowId={workflowId}
              nextPosition={workflow.steps.length}
              role={role}
              stepTypes={typeData?.step_types ?? []}
              onAdded={refetch}
            />
          ) : (
            <Panel className="mt-4 p-4">
              <p className="text-[12px] text-[var(--color-ink-faint)]">
                Read-only. Viewers cannot add or edit steps.
              </p>
            </Panel>
          )}
        </section>

        <aside className="space-y-8">
          <Triggers
            workflow={workflow}
            role={role}
            triggerTypes={typeData?.trigger_types ?? []}
            onChanged={refetch}
          />
          <RunHistory orgId={orgId} runs={runs} />
        </aside>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function StepCard({
  step,
  index,
  total,
  canEdit,
  isOwner,
  ownerOnly,
  stepNames,
  neighbours,
  onChanged,
}: {
  step: StepRow;
  index: number;
  total: number;
  canEdit: boolean;
  isOwner: boolean;
  ownerOnly: boolean;
  stepNames: string[];
  neighbours: StepRow[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(step.name);
  const [config, setConfig] = useState<Record<string, unknown>>(step.config ?? {});
  const [updateStep, { loading: saving, error: saveError }] = useMutation(UPDATE_STEP);
  const [deleteStep] = useMutation(DELETE_STEP);
  const [swap] = useMutation(SWAP_STEPS);

  // An editor may not modify an owner-only step, matching the Hasura rule.
  const editable = canEdit && (!ownerOnly || isOwner);

  async function save() {
    await updateStep({ variables: { id: step.id, set: { name, config } } });
    onChanged();
  }

  async function move(dir: -1 | 1) {
    const other = neighbours[index + dir];
    if (!other) return;
    await swap({
      variables: { aId: step.id, aPos: other.position, bId: other.id, bPos: step.position },
    });
    onChanged();
  }

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center gap-3 p-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center border border-[var(--color-line-bright)] font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-faint)]">
          {step.position}
        </span>
        <span className="grid h-8 w-8 shrink-0 place-items-center text-[15px] text-[var(--color-amber)]">
          {STEP_GLYPH[step.type] ?? '·'}
        </span>

        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <div className="truncate font-[family-name:var(--font-mono)] text-[13px] text-[var(--color-ink)]">
            {step.name}
          </div>
          <div className="flex items-center gap-2 text-[10px] tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
            {step.type}
            {ownerOnly ? (
              <span className="border border-[var(--color-warn)]/40 px-1 text-[var(--color-warn)]">
                owner only
              </span>
            ) : null}
          </div>
        </button>

        {canEdit ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" onClick={() => move(-1)} disabled={index === 0} title="move up">
              ↑
            </Button>
            <Button
              variant="ghost"
              onClick={() => move(1)}
              disabled={index === total - 1}
              title="move down"
            >
              ↓
            </Button>
            <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
              {open ? 'close' : 'edit'}
            </Button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-panel-2)] p-4">
          {!editable ? (
            <p className="mb-4 border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/8 px-3 py-2 text-[12px] text-[var(--color-warn)]">
              This is an owner-only step type. Your role cannot modify it — the same rule is
              enforced by the Hasura update permission, so the form is disabled rather than
              failing on save.
            </p>
          ) : null}

          <fieldset disabled={!editable} className="space-y-3 disabled:opacity-60">
            <Field label="step name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <StepConfigForm
              type={step.type}
              config={config}
              onChange={setConfig}
              stepNames={stepNames.filter((n) => n !== step.name)}
            />
          </fieldset>

          {saveError ? (
            <div className="mt-3">
              <ErrorNote>{saveError.message}</ErrorNote>
            </div>
          ) : null}

          {editable ? (
            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" onClick={save} disabled={saving}>
                {saving ? 'saving…' : 'save step'}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await deleteStep({ variables: { id: step.id } });
                  onChanged();
                }}
              >
                delete
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function AddStep({
  workflowId,
  nextPosition,
  role,
  stepTypes,
  onAdded,
}: {
  workflowId: string;
  nextPosition: number;
  role: OrgRole | null;
  stepTypes: { value: StepType; description: string; owner_only: boolean }[];
  onAdded: () => void;
}) {
  const [type, setType] = useState<StepType>('llm_call');
  const [name, setName] = useState('');
  const [addStep, { loading, error }] = useMutation(ADD_STEP);

  const chosen = stepTypes.find((t) => t.value === type);
  const blocked = chosen?.owner_only && role !== 'owner';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await addStep({
      variables: {
        workflowId,
        position: nextPosition,
        type,
        name: name || defaultName(type),
        config: DEFAULT_CONFIG[type],
      },
    });
    setName('');
    onAdded();
  }

  return (
    <Panel className="mt-4 p-4">
      <Label>add step</Label>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[190px]">
          <Field label="type">
            <Select value={type} onChange={(e) => setType(e.target.value as StepType)}>
              {stepTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.value}
                  {t.owner_only ? ' (owner only)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="min-w-[200px] flex-1">
          <Field label="name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName(type)}
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={loading || blocked}>
          {loading ? 'adding…' : '+ add'}
        </Button>
      </form>

      {chosen ? (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {chosen.description}
        </p>
      ) : null}

      {blocked ? (
        <p className="mt-2 border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/8 px-3 py-2 text-[12px] leading-relaxed text-[var(--color-warn)]">
          <strong>{type}</strong> reaches outside the sandbox, so only an owner can add it. Your
          role is {role}. The Hasura insert permission enforces this independently — the disabled
          button is a courtesy, not the control.
        </p>
      ) : null}

      {error ? (
        <div className="mt-3">
          <ErrorNote>{error.message}</ErrorNote>
        </div>
      ) : null}
    </Panel>
  );
}

function defaultName(type: StepType): string {
  return {
    llm_call: 'Classify alert',
    http_request: 'Fetch context',
    db_write: 'Record result',
    notify: 'Alert the team',
    conditional_branch: 'Urgent?',
    approval_gate: 'Human approval',
  }[type];
}

/* -------------------------------------------------------------------------- */

function Triggers({
  workflow,
  role,
  triggerTypes,
  onChanged,
}: {
  workflow: WorkflowDetail;
  role: OrgRole | null;
  triggerTypes: { value: TriggerType; description: string; owner_only: boolean }[];
  onChanged: () => void;
}) {
  const [type, setType] = useState<TriggerType>('webhook');
  const [cron, setCron] = useState('*/5 * * * *');
  const [kind, setKind] = useState('lead');
  const [addTrigger, { loading, error }] = useMutation(ADD_TRIGGER);
  const [deleteTrigger] = useMutation(DELETE_TRIGGER);
  const [insertRecord, { loading: firing }] = useMutation(INSERT_WATCHED_RECORD);
  const [fired, setFired] = useState(false);

  const canEdit = role === 'owner' || role === 'editor';
  const chosen = triggerTypes.find((t) => t.value === type);
  const blocked = chosen?.owner_only && role !== 'owner';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await addTrigger({
      variables: {
        workflowId: workflow.id,
        type,
        config: type === 'database_event' ? { kind } : {},
        cron: type === 'scheduled' ? cron : null,
      },
    });
    onChanged();
  }

  const hasDbEventTrigger = workflow.triggers.some(
    (t) => t.type === 'database_event' && t.is_active,
  );

  return (
    <Panel className="p-4">
      <h2 className="font-[family-name:var(--font-mono)] text-[13px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">
        Triggers
      </h2>

      <div className="mt-3 space-y-2">
        {workflow.triggers.map((t) => (
          <TriggerCard
            key={t.id}
            trigger={t}
            isOwner={role === 'owner'}
            canEdit={canEdit}
            onDelete={async () => {
              await deleteTrigger({ variables: { id: t.id } });
              onChanged();
            }}
          />
        ))}
        {workflow.triggers.length === 0 ? (
          <p className="text-[12px] text-[var(--color-ink-faint)]">
            Manual only. Attach a webhook, schedule, or database event below.
          </p>
        ) : null}
      </div>

      {canEdit ? (
        <form onSubmit={submit} className="mt-4 space-y-3 border-t border-[var(--color-line)] pt-4">
          <Field label="add trigger">
            <Select value={type} onChange={(e) => setType(e.target.value as TriggerType)}>
              {triggerTypes
                .filter((t) => t.value !== 'manual')
                .map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.value}
                    {t.owner_only ? ' (owner only)' : ''}
                  </option>
                ))}
            </Select>
          </Field>

          {type === 'scheduled' ? (
            <Field label="cron (utc)" hint="Standard 5-field expression, evaluated every minute.">
              <Input value={cron} onChange={(e) => setCron(e.target.value)} />
            </Field>
          ) : null}
          {type === 'database_event' ? (
            <Field label="record kind" hint="Only watched_records of this kind start a run.">
              <Input value={kind} onChange={(e) => setKind(e.target.value)} />
            </Field>
          ) : null}

          <Button type="submit" variant="primary" disabled={loading || blocked}>
            {loading ? 'attaching…' : '+ attach trigger'}
          </Button>

          {blocked ? (
            <p className="border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/8 px-3 py-2 text-[11px] leading-relaxed text-[var(--color-warn)]">
              A webhook trigger is an unauthenticated door into this org, so only an owner can
              attach one.
            </p>
          ) : null}
          {error ? <ErrorNote>{error.message}</ErrorNote> : null}
        </form>
      ) : null}

      {hasDbEventTrigger && canEdit ? (
        <div className="mt-4 border-t border-[var(--color-line)] pt-4">
          <Label>fire the database event</Label>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
            Inserts a row into <code>watched_records</code>. Hasura&apos;s Event Trigger picks it up
            and starts a run — no button in this app calls the executor.
          </p>
          <Button
            className="mt-3"
            disabled={firing}
            onClick={async () => {
              await insertRecord({
                variables: {
                  orgId: workflow.org_id,
                  kind: 'lead',
                  payload: { subject: 'Production database is down', source: 'db-event' },
                },
              });
              setFired(true);
            }}
          >
            {firing ? 'inserting…' : 'insert watched record'}
          </Button>
          {fired ? (
            <p className="mt-2 text-[11px] text-[var(--color-live)]">
              Row inserted. A new run should appear in the history within a second or two.
            </p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function TriggerCard({
  trigger,
  isOwner,
  canEdit,
  onDelete,
}: {
  trigger: TriggerRow;
  isOwner: boolean;
  canEdit: boolean;
  onDelete: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const { data, loading, error } = useQuery<{
    getWebhookEndpoint: { url: string; method: string; sample_curl: string };
  }>(GET_WEBHOOK_ENDPOINT, {
    variables: { triggerId: trigger.id },
    skip: !revealed,
    fetchPolicy: 'network-only',
  });

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
      <div className="flex items-center gap-2">
        <span className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.1em] text-[var(--color-amber)]">
          {trigger.type}
        </span>
        {trigger.cron ? (
          <code className="text-[11px] text-[var(--color-ink-dim)]">{trigger.cron}</code>
        ) : null}
        <span className="ml-auto text-[10px] text-[var(--color-ink-faint)]">
          {trigger.last_fired_at
            ? `fired ${new Date(trigger.last_fired_at).toLocaleTimeString()}`
            : 'never fired'}
        </span>
      </div>

      {trigger.type === 'webhook' ? (
        <div className="mt-2">
          {isOwner ? (
            <Button variant="ghost" onClick={() => setRevealed((v) => !v)}>
              {revealed ? 'hide endpoint' : 'reveal endpoint'}
            </Button>
          ) : (
            <p className="text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              The token is owner-only. It is not a selectable column for any role — owners fetch
              it through the <code>getWebhookEndpoint</code> Action.
            </p>
          )}
          {loading ? <Spinner label="fetching" /> : null}
          {error ? <ErrorNote>{error.message}</ErrorNote> : null}
          {data ? (
            <div className="mt-2">
              <JsonBlock value={data.getWebhookEndpoint.sample_curl} max={220} />
            </div>
          ) : null}
        </div>
      ) : null}

      {canEdit ? (
        <div className="mt-2">
          <Button variant="ghost" onClick={onDelete}>
            remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RunHistory({ orgId, runs }: { orgId: string; runs: RunRow[] }) {
  return (
    <Panel className="p-4">
      <h2 className="font-[family-name:var(--font-mono)] text-[13px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">
        Recent runs
      </h2>
      <div className="mt-3 space-y-1.5">
        {runs.map((r) => (
          <Link key={r.id} href={`/run/${r.id}`} className="block">
            <div className="flex items-center gap-3 border border-[var(--color-line)] bg-[var(--color-panel-2)] p-2.5 transition-colors hover:border-[var(--color-amber)]">
              <div className="min-w-0 flex-1">
                <RunStatusChip status={r.status} />
                <div className="mt-1 truncate text-[10px] text-[var(--color-ink-faint)]">
                  {r.trigger_type} ·{' '}
                  {r.triggered_by_user?.displayName ?? 'system'} ·{' '}
                  {new Date(r.created_at).toLocaleTimeString()}
                </div>
              </div>
              <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                open →
              </span>
            </div>
          </Link>
        ))}
        {runs.length === 0 ? (
          <p className="text-[12px] text-[var(--color-ink-faint)]">No runs yet.</p>
        ) : null}
      </div>
      <Link
        href={`/org/${orgId}`}
        className="mt-3 inline-block font-[family-name:var(--font-mono)] text-[10px] tracking-[0.12em] text-[var(--color-ink-faint)] uppercase hover:text-[var(--color-amber)]"
      >
        ← all workflows
      </Link>
    </Panel>
  );
}
