-- AgentFlow: AI agent workflow builder
-- Core schema. Everything below lives in `public`; auth.users is owned by nhost.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Lookup tables.
--
-- Plain text + FK rather than native PG enums, for two reasons: adding a value
-- is an INSERT rather than an ALTER TYPE that takes a lock, and — more
-- importantly — a lookup row can carry attributes. `step_types.owner_only`
-- below is read directly by a Hasura permission rule, so the step-level
-- permission gate is driven by data instead of a list hardcoded in metadata.
-- ---------------------------------------------------------------------------

CREATE TABLE public.org_roles (
  value       text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO public.org_roles (value, description) VALUES
  ('owner',  'Full control over workflows, steps, triggers and org membership'),
  ('editor', 'Can create and edit workflows and steps, and trigger runs'),
  ('viewer', 'Read-only. Cannot trigger a run.');

CREATE TABLE public.step_types (
  value       text PRIMARY KEY,
  description text NOT NULL,
  -- Step types that reach outside the sandbox and are therefore owner-only.
  -- This is data, not a hardcoded list in a permission rule, so the gate and
  -- the UI read from the same source of truth.
  owner_only  boolean NOT NULL DEFAULT false
);
INSERT INTO public.step_types (value, description, owner_only) VALUES
  ('llm_call',           'Calls a real LLM API',                                  false),
  ('http_request',       'Generic call to any external API',                      false),
  ('db_write',           'Writes a result into our own tables',                   true),
  ('notify',             'Slack/email alert, delivered by an Event Trigger',      true),
  ('conditional_branch', 'if/else on the previous step output',                   false),
  ('approval_gate',      'Pauses the run until an authorised user approves',      false);

CREATE TABLE public.trigger_types (
  value       text PRIMARY KEY,
  description text NOT NULL,
  owner_only  boolean NOT NULL DEFAULT false
);
INSERT INTO public.trigger_types (value, description, owner_only) VALUES
  ('manual',         'A user clicks Run',                                    false),
  ('webhook',        'Inbound Hasura Action an external system calls',       true),
  ('scheduled',      'Cron, via a Hasura Cron Trigger',                      false),
  ('database_event', 'Row change on a watched table, via an Event Trigger',  false);

CREATE TABLE public.run_statuses (value text PRIMARY KEY, description text NOT NULL);
INSERT INTO public.run_statuses (value, description) VALUES
  ('pending',   'Created, not yet picked up'),
  ('running',   'Executing steps'),
  ('paused',    'Stopped at an approval_gate, awaiting a decision'),
  ('succeeded', 'All steps completed'),
  ('failed',    'A step failed after exhausting retries'),
  ('rejected',  'An approval_gate was rejected');

CREATE TABLE public.step_run_statuses (value text PRIMARY KEY, description text NOT NULL);
INSERT INTO public.step_run_statuses (value, description) VALUES
  ('pending',            'Not started'),
  ('running',            'In flight'),
  ('awaiting_approval',  'Paused, awaiting approval'),
  ('succeeded',          'Completed'),
  ('failed',             'Failed after exhausting retries'),
  ('skipped',            'Skipped by a conditional_branch'),
  ('rejected',           'Approval was denied');

-- ---------------------------------------------------------------------------
-- Organizations and membership
-- ---------------------------------------------------------------------------

CREATE TABLE public.organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  -- Quota is per calendar month. `quota_used` is incremented atomically at run
  -- admission (see consume_org_quota) rather than at completion, because a
  -- completion-time increment lets N concurrent runs all pass a check that only
  -- one of them should have passed.
  quota_limit        integer NOT NULL DEFAULT 100 CHECK (quota_limit >= 0),
  quota_used         integer NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  quota_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES public.org_roles(value) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX org_members_user_id_idx ON public.org_members (user_id);
CREATE INDEX org_members_org_id_idx  ON public.org_members (org_id);

-- ---------------------------------------------------------------------------
-- Workflow definition
-- ---------------------------------------------------------------------------

CREATE TABLE public.workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_id_idx ON public.workflows (org_id);

CREATE TABLE public.workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position    integer NOT NULL CHECK (position >= 0),
  type        text NOT NULL REFERENCES public.step_types(value) ON UPDATE CASCADE,
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- DEFERRABLE so a reorder can renumber several rows in one transaction
  -- without tripping over a transient collision.
  CONSTRAINT workflow_steps_workflow_id_position_key
    UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX workflow_steps_workflow_id_idx ON public.workflow_steps (workflow_id);

CREATE TABLE public.workflow_triggers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type          text NOT NULL REFERENCES public.trigger_types(value) ON UPDATE CASCADE,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bearer token for inbound webhook triggers. Anyone holding this can start a
  -- run, so it is owner-only at the column level in Hasura.
  webhook_token text UNIQUE,
  -- Cron expression for scheduled triggers, evaluated by the cron dispatcher.
  cron          text,
  is_active     boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_triggers_workflow_id_idx ON public.workflow_triggers (workflow_id);
CREATE INDEX workflow_triggers_type_active_idx ON public.workflow_triggers (type, is_active);

-- ---------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------

CREATE TABLE public.workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  -- Denormalised from workflows so quota aggregation does not have to join, and
  -- so a run is still attributable if the workflow row is later renamed/moved.
  -- Permission rules deliberately do NOT trust this column: they traverse
  -- workflow -> organization -> org_members instead.
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending' REFERENCES public.run_statuses(value) ON UPDATE CASCADE,
  trigger_type  text NOT NULL REFERENCES public.trigger_types(value) ON UPDATE CASCADE,
  triggered_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  -- Position of the next step to execute. Makes resume-after-approval a plain
  -- "continue from here" rather than a replay.
  cursor        integer NOT NULL DEFAULT 0,
  quota_counted boolean NOT NULL DEFAULT false,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_workflow_id_idx ON public.workflow_runs (workflow_id);
CREATE INDEX workflow_runs_org_id_created_at_idx ON public.workflow_runs (org_id, created_at DESC);

CREATE TABLE public.step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_id         uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  position        integer NOT NULL,
  type            text NOT NULL REFERENCES public.step_types(value) ON UPDATE CASCADE,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' REFERENCES public.step_run_statuses(value) ON UPDATE CASCADE,
  input           jsonb,
  output          jsonb,
  error           text,
  attempt         integer NOT NULL DEFAULT 0,
  approved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, position)
);
CREATE INDEX step_runs_workflow_run_id_idx ON public.step_runs (workflow_run_id, position);

-- Target of `db_write` steps.
CREATE TABLE public.step_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs(id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX step_outputs_org_id_idx ON public.step_outputs (org_id);
CREATE INDEX step_outputs_run_idx ON public.step_outputs (workflow_run_id);

-- Target of `notify` steps. An INSERT here fires a Hasura Event Trigger which
-- does the actual delivery, so the executor never blocks on Slack being slow.
CREATE TABLE public.notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id   uuid REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id       uuid REFERENCES public.step_runs(id) ON DELETE CASCADE,
  channel           text NOT NULL DEFAULT 'slack',
  target            text,
  subject           text,
  body              text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  delivery_response jsonb,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org_id_idx ON public.notifications (org_id, created_at DESC);

-- Source table for the database-event trigger. An INSERT here starts a run of
-- every active `database_event` workflow in the same org.
CREATE TABLE public.watched_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'lead',
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watched_records_org_id_idx ON public.watched_records (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_organizations_updated_at     BEFORE UPDATE ON public.organizations     FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
CREATE TRIGGER set_workflows_updated_at         BEFORE UPDATE ON public.workflows         FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
CREATE TRIGGER set_workflow_steps_updated_at    BEFORE UPDATE ON public.workflow_steps    FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
CREATE TRIGGER set_workflow_triggers_updated_at BEFORE UPDATE ON public.workflow_triggers FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
CREATE TRIGGER set_workflow_runs_updated_at     BEFORE UPDATE ON public.workflow_runs     FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
CREATE TRIGGER set_step_runs_updated_at         BEFORE UPDATE ON public.step_runs         FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- Integrity: a run's denormalised org_id must match its workflow's org, and a
-- webhook trigger must actually carry a token. Enforced in the database so a
-- bug in the handler cannot produce a cross-org row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_run_org_matches_workflow()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wf_org uuid;
BEGIN
  SELECT org_id INTO wf_org FROM public.workflows WHERE id = NEW.workflow_id;
  IF wf_org IS NULL THEN
    RAISE EXCEPTION 'workflow % does not exist', NEW.workflow_id;
  END IF;
  IF NEW.org_id IS DISTINCT FROM wf_org THEN
    RAISE EXCEPTION 'workflow_runs.org_id (%) does not match workflow org (%)', NEW.org_id, wf_org;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_run_org
  BEFORE INSERT OR UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_run_org_matches_workflow();

ALTER TABLE public.workflow_triggers
  ADD CONSTRAINT workflow_triggers_webhook_needs_token
  CHECK (type <> 'webhook' OR webhook_token IS NOT NULL);

ALTER TABLE public.workflow_triggers
  ADD CONSTRAINT workflow_triggers_scheduled_needs_cron
  CHECK (type <> 'scheduled' OR cron IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Quota admission control.
--
-- Single statement that both checks and reserves, so two concurrent runs on an
-- org with one call remaining cannot both be admitted. Returns the decision
-- plus the resulting counters.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.consume_org_quota(p_org_id uuid)
RETURNS TABLE (allowed boolean, quota_used integer, quota_limit integer)
LANGUAGE plpgsql AS $$
DECLARE
  cur_period date := date_trunc('month', now())::date;
BEGIN
  -- Roll the period over first, so a new month starts from zero.
  UPDATE public.organizations o
     SET quota_used         = 0,
         quota_period_start = cur_period
   WHERE o.id = p_org_id
     AND o.quota_period_start < cur_period;

  UPDATE public.organizations o
     SET quota_used = o.quota_used + 1
   WHERE o.id = p_org_id
     AND o.quota_used < o.quota_limit
  RETURNING true, o.quota_used, o.quota_limit
       INTO allowed, quota_used, quota_limit;

  IF NOT FOUND THEN
    SELECT false, o.quota_used, o.quota_limit
      INTO allowed, quota_used, quota_limit
      FROM public.organizations o
     WHERE o.id = p_org_id;
  END IF;

  RETURN NEXT;
END;
$$;

-- Refund a reservation for a run that never executed a step.
CREATE OR REPLACE FUNCTION public.refund_org_quota(p_org_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE public.organizations
     SET quota_used = greatest(quota_used - 1, 0)
   WHERE id = p_org_id;
$$;

-- ---------------------------------------------------------------------------
-- Aggregation: org usage for the current month.
--
-- A view rather than a computed field because it aggregates across two tables
-- and is read once per page load; Hasura tracks it with its own org-scoped
-- select permission.
-- ---------------------------------------------------------------------------

CREATE VIEW public.org_usage_current_month AS
SELECT
  o.id                                             AS org_id,
  o.quota_limit                                    AS quota_limit,
  o.quota_used                                     AS quota_used,
  greatest(o.quota_limit - o.quota_used, 0)        AS quota_remaining,
  o.quota_period_start                             AS quota_period_start,
  coalesce(r.runs_this_month, 0)                   AS runs_this_month,
  coalesce(r.succeeded_runs, 0)                    AS succeeded_runs,
  coalesce(r.failed_runs, 0)                       AS failed_runs,
  coalesce(r.paused_runs, 0)                       AS paused_runs,
  coalesce(s.steps_executed, 0)                    AS steps_executed,
  r.avg_run_seconds                                AS avg_run_seconds
FROM public.organizations o
LEFT JOIN LATERAL (
  SELECT
    count(*)                                              AS runs_this_month,
    count(*) FILTER (WHERE wr.status = 'succeeded')       AS succeeded_runs,
    count(*) FILTER (WHERE wr.status = 'failed')          AS failed_runs,
    count(*) FILTER (WHERE wr.status = 'paused')          AS paused_runs,
    round(avg(extract(epoch FROM (wr.finished_at - wr.started_at)))::numeric, 2) AS avg_run_seconds
  FROM public.workflow_runs wr
  WHERE wr.org_id = o.id
    AND wr.created_at >= date_trunc('month', now())
) r ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS steps_executed
  FROM public.step_runs sr
  JOIN public.workflow_runs wr2 ON wr2.id = sr.workflow_run_id
  WHERE wr2.org_id = o.id
    AND sr.created_at >= date_trunc('month', now())
    AND sr.status IN ('succeeded', 'failed')
) s ON true;
