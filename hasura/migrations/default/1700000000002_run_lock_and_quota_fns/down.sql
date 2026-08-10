DROP FUNCTION IF EXISTS public.release_run_lock(uuid, uuid);
DROP FUNCTION IF EXISTS public.acquire_run_lock(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.refund_org_quota(uuid);
DROP FUNCTION IF EXISTS public.consume_org_quota(uuid);
ALTER TABLE public.workflow_runs DROP COLUMN IF EXISTS lock_token, DROP COLUMN IF EXISTS locked_until;
