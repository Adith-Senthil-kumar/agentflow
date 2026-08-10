-- ---------------------------------------------------------------------------
-- Execution lease.
--
-- A run can be nudged forward by six different entry points (manual Action,
-- inbound webhook, cron dispatch, database event, approval resume, and the
-- executor's own continuation call after it exhausts its time budget). Without
-- a lease, two of those arriving together would execute the same step twice —
-- which for an llm_call or http_request step means a duplicated side effect.
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflow_runs
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN lock_token   uuid;

-- Returns the locked row, or zero rows if someone else holds the lease or the
-- run is no longer in a runnable state. Expressing "did I get it?" as row count
-- keeps the whole thing callable over GraphQL with no raw SQL in the app.
CREATE OR REPLACE FUNCTION public.acquire_run_lock(
  p_run_id uuid,
  p_token uuid,
  p_ttl_seconds integer
)
RETURNS SETOF public.workflow_runs
LANGUAGE sql VOLATILE AS $$
  UPDATE public.workflow_runs
     SET locked_until = now() + make_interval(secs => p_ttl_seconds),
         lock_token   = p_token
   WHERE id = p_run_id
     AND status IN ('pending', 'running')
     AND (locked_until IS NULL OR locked_until < now())
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.release_run_lock(p_run_id uuid, p_token uuid)
RETURNS SETOF public.workflow_runs
LANGUAGE sql VOLATILE AS $$
  UPDATE public.workflow_runs
     SET locked_until = NULL, lock_token = NULL
   WHERE id = p_run_id AND lock_token = p_token
  RETURNING *;
$$;

-- ---------------------------------------------------------------------------
-- Quota admission, restated as SETOF organizations.
--
-- Returning rows rather than a scalar lets Hasura track the function (Hasura
-- can only track functions returning SETOF a tracked table), so the executor
-- calls it over GraphQL like anything else. Zero rows back means "denied";
-- one row back means "reserved", and that row carries the resulting counters.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.consume_org_quota(uuid);
DROP FUNCTION IF EXISTS public.refund_org_quota(uuid);

CREATE OR REPLACE FUNCTION public.consume_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  cur_period date := date_trunc('month', now())::date;
BEGIN
  -- Roll the period over first so a new calendar month starts from zero.
  UPDATE public.organizations
     SET quota_used = 0, quota_period_start = cur_period
   WHERE id = p_org_id AND quota_period_start < cur_period;

  -- Check and reserve in one statement. Two concurrent triggers on an org with
  -- one call left cannot both pass this, which a read-then-write pair, or an
  -- increment deferred to run completion, would both allow.
  RETURN QUERY
    UPDATE public.organizations
       SET quota_used = quota_used + 1
     WHERE id = p_org_id
       AND quota_used < quota_limit
    RETURNING *;
END;
$$;

-- Hands a reservation back when a run is rejected before executing any step.
CREATE OR REPLACE FUNCTION public.refund_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE sql VOLATILE AS $$
  UPDATE public.organizations
     SET quota_used = greatest(quota_used - 1, 0)
   WHERE id = p_org_id
  RETURNING *;
$$;
