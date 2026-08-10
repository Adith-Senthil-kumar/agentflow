DROP VIEW IF EXISTS public.org_usage_current_month;

DROP FUNCTION IF EXISTS public.refund_org_quota(uuid);
DROP FUNCTION IF EXISTS public.consume_org_quota(uuid);
DROP FUNCTION IF EXISTS public.enforce_run_org_matches_workflow() CASCADE;

DROP TABLE IF EXISTS public.watched_records;
DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.step_outputs;
DROP TABLE IF EXISTS public.step_runs;
DROP TABLE IF EXISTS public.workflow_runs;
DROP TABLE IF EXISTS public.workflow_triggers;
DROP TABLE IF EXISTS public.workflow_steps;
DROP TABLE IF EXISTS public.workflows;
DROP TABLE IF EXISTS public.org_members;
DROP TABLE IF EXISTS public.organizations;

DROP TABLE IF EXISTS public.step_run_statuses;
DROP TABLE IF EXISTS public.run_statuses;
DROP TABLE IF EXISTS public.trigger_types;
DROP TABLE IF EXISTS public.step_types;
DROP TABLE IF EXISTS public.org_roles;

DROP FUNCTION IF EXISTS public.set_current_timestamp_updated_at() CASCADE;
