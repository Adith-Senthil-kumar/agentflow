import 'server-only';
import { gqlAdmin } from '../hasura';
import { PermanentError } from '../retry';
import type { DbWriteConfig } from '../types';
import type { StepExecutor } from './types';

/**
 * Persists a result into our own tables.
 *
 * `org_id` is taken from the run, never from step config. The step author can
 * choose what to write, not where it lands — so an owner-authored db_write step
 * cannot be pointed at another organisation's rows even though this code runs
 * with admin privileges.
 */
export const executeDbWrite: StepExecutor = async ({ config, run, stepRunId, onAttempt }) => {
  const cfg = config as unknown as DbWriteConfig;

  if (!cfg.key || typeof cfg.key !== 'string') {
    throw new PermanentError('db_write requires a `key` in its config');
  }

  await onAttempt(1);

  const data = await gqlAdmin<{ insert_step_outputs_one: { id: string; created_at: string } }>(
    `mutation WriteStepOutput($object: step_outputs_insert_input!) {
       insert_step_outputs_one(object: $object) { id created_at }
     }`,
    {
      object: {
        org_id: run.org_id,
        workflow_run_id: run.id,
        step_run_id: stepRunId,
        key: cfg.key,
        value: cfg.value ?? null,
      },
    },
  );

  return {
    output: {
      written: true,
      step_output_id: data.insert_step_outputs_one.id,
      key: cfg.key,
      value: cfg.value ?? null,
    },
  };
};
