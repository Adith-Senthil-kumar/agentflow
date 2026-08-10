export type OrgRole = 'owner' | 'editor' | 'viewer';

export type StepType =
  | 'llm_call'
  | 'http_request'
  | 'db_write'
  | 'notify'
  | 'conditional_branch'
  | 'approval_gate';

export type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'rejected';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'rejected';

/**
 * Step types that reach outside the sandbox. Mirrors `step_types.owner_only` in
 * the database, which is what the Hasura permission rule reads. The handler
 * re-derives the same answer from the database rather than trusting this list,
 * so the two can never silently diverge — this constant exists only so the UI
 * can grey out controls without an extra round trip.
 */
export const OWNER_ONLY_STEP_TYPES: StepType[] = ['db_write', 'notify'];
export const OWNER_ONLY_TRIGGER_TYPES: TriggerType[] = ['webhook'];

export const ROLES_THAT_CAN_RUN: OrgRole[] = ['owner', 'editor'];
export const ROLES_THAT_CAN_APPROVE: OrgRole[] = ['owner', 'editor'];
export const ROLES_THAT_CAN_EDIT: OrgRole[] = ['owner', 'editor'];

export type ComparisonOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'gt'
  | 'lt'
  | 'matches'
  | 'is_empty'
  | 'is_not_empty';

export type BranchAction =
  | { action: 'continue' }
  | { action: 'goto'; position: number }
  | { action: 'end' };

export interface LlmCallConfig {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface HttpRequestConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
}

export interface DbWriteConfig {
  key: string;
  value: unknown;
}

export interface NotifyConfig {
  channel?: 'slack' | 'email';
  target?: string;
  subject?: string;
  body: string;
}

export interface ConditionalBranchConfig {
  left: string;
  operator: ComparisonOperator;
  right?: string;
  on_true?: BranchAction;
  on_false?: BranchAction;
}

export interface ApprovalGateConfig {
  instructions?: string;
  /** Defaults to owner|editor. Never widens beyond org membership. */
  allowed_roles?: OrgRole[];
}

export type StepConfig =
  | LlmCallConfig
  | HttpRequestConfig
  | DbWriteConfig
  | NotifyConfig
  | ConditionalBranchConfig
  | ApprovalGateConfig;

export interface WorkflowStepRow {
  id: string;
  workflow_id: string;
  position: number;
  type: StepType;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  org_id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  triggered_by: string | null;
  context: RunContext;
  cursor: number;
  quota_counted: boolean;
}

export interface StepRunRow {
  id: string;
  workflow_run_id: string;
  step_id: string | null;
  position: number;
  type: StepType;
  name: string;
  status: StepRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  attempt: number;
}

/**
 * Accumulated state threaded through a run. `steps` is keyed by step name so a
 * later step can reference an earlier one explicitly ({{steps.Classify.text}}),
 * and `last` always points at the most recent successful output.
 */
export interface RunContext {
  trigger?: Record<string, unknown>;
  steps?: Record<string, unknown>;
  last?: unknown;
  [k: string]: unknown;
}

export interface StepResult {
  output: unknown;
  /** Set by conditional_branch to redirect the cursor. */
  branch?: BranchAction;
}
