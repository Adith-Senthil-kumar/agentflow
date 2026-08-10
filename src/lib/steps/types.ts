import type { RunContext, StepResult, WorkflowRunRow, WorkflowStepRow } from '../types';

export interface StepExecutionArgs {
  step: WorkflowStepRow;
  /** Config with every `{{...}}` reference already resolved against `ctx`. */
  config: Record<string, unknown>;
  ctx: RunContext;
  run: WorkflowRunRow;
  stepRunId: string;
  /** Persists the attempt number so retries show up live in the subscription. */
  onAttempt: (attempt: number) => Promise<void>;
}

export type StepExecutor = (args: StepExecutionArgs) => Promise<StepResult>;

export type { RunContext, StepResult, WorkflowRunRow, WorkflowStepRow };
