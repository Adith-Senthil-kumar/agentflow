-- Quota is checked when a run is admitted and incremented when it completes.
--
-- Replaces the earlier check-and-reserve-in-one-statement approach. The two
-- steps are now separate, which is what makes "increments on completion" true:
-- a run that never finishes never consumes quota.

DROP FUNCTION IF EXISTS public.consume_org_quota(uuid);
DROP FUNCTION IF EXISTS public.refund_org_quota(uuid);

-- Rolls the quota window over if the calendar month changed, then returns the
-- org so the caller can compare quota_used against quota_limit. Rolling has to
-- happen at check time, otherwise the first run of a new month is measured
-- against last month's counter.
CREATE OR REPLACE FUNCTION public.roll_org_quota_period(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  cur_period date := date_trunc('month', now())::date;
BEGIN
  UPDATE public.organizations
     SET quota_used = 0,
         quota_period_start = cur_period
   WHERE id = p_org_id
     AND quota_period_start < cur_period;

  RETURN QUERY SELECT * FROM public.organizations WHERE id = p_org_id;
END;
$$;

-- Called once per run, when it reaches a terminal state. The caller claims the
-- run first (workflow_runs.quota_counted false -> true, conditionally), so a
-- retried or duplicated finalisation cannot double-count.
CREATE OR REPLACE FUNCTION public.increment_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE sql VOLATILE AS $$
  UPDATE public.organizations
     SET quota_used = quota_used + 1
   WHERE id = p_org_id
  RETURNING *;
$$;
