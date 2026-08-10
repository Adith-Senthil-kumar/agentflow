import { gql } from '@apollo/client';

/* ---------------------------------------------------------------------------
 * Every document here runs with the signed-in user's JWT. None of them filter
 * by org id for security purposes — the Hasura row permissions do that. Where
 * an org id appears it is a UI scope ("show me this org"), and passing another
 * org's id simply returns nothing.
 * ------------------------------------------------------------------------- */

export const MY_ORGS = gql`
  query MyOrgs {
    org_members(order_by: { org: { name: asc } }) {
      id
      role
      org {
        id
        name
        slug
      }
    }
  }
`;

/** Required aggregation: quota position + run stats for the current month. */
export const ORG_USAGE = gql`
  query OrgUsage($orgId: uuid!) {
    org_usage_current_month(where: { org_id: { _eq: $orgId } }) {
      org_id
      quota_limit
      quota_used
      quota_remaining
      quota_period_start
      runs_this_month
      succeeded_runs
      failed_runs
      paused_runs
      steps_executed
      avg_run_seconds
    }
  }
`;

/**
 * Required query: an org's workflows with their steps, triggers and most recent
 * run status. The nested `runs` uses order_by + limit 1 so "most recent" costs
 * one lateral join per workflow rather than a second round trip.
 */
export const ORG_WORKFLOWS = gql`
  query OrgWorkflows($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      is_active
      created_at
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
      }
      triggers(order_by: { created_at: asc }) {
        id
        type
        config
        cron
        is_active
        last_fired_at
      }
      runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
  }
`;

export const WORKFLOW_DETAIL = gql`
  query WorkflowDetail($workflowId: uuid!) {
    workflows_by_pk(id: $workflowId) {
      id
      org_id
      name
      description
      is_active
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
      }
      triggers(order_by: { created_at: asc }) {
        id
        type
        config
        cron
        is_active
        last_fired_at
      }
      runs(order_by: { created_at: desc }, limit: 12) {
        id
        status
        trigger_type
        created_at
        started_at
        finished_at
        triggered_by_user {
          id
          displayName
        }
      }
    }
  }
`;

export const STEP_TYPES = gql`
  query StepTypes {
    step_types(order_by: { value: asc }) {
      value
      description
      owner_only
    }
    trigger_types(order_by: { value: asc }) {
      value
      description
      owner_only
    }
  }
`;

/* --------------------------------- mutations ------------------------------ */

export const CREATE_WORKFLOW = gql`
  mutation CreateWorkflow($orgId: uuid!, $name: String!, $description: String) {
    insert_workflows_one(
      object: { org_id: $orgId, name: $name, description: $description }
    ) {
      id
      name
    }
  }
`;

export const UPDATE_WORKFLOW = gql`
  mutation UpdateWorkflow($id: uuid!, $set: workflows_set_input!) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      name
      description
      is_active
    }
  }
`;

export const DELETE_WORKFLOW = gql`
  mutation DeleteWorkflow($id: uuid!) {
    delete_workflows_by_pk(id: $id) {
      id
    }
  }
`;

export const ADD_STEP = gql`
  mutation AddStep(
    $workflowId: uuid!
    $position: Int!
    $type: String!
    $name: String!
    $config: jsonb!
  ) {
    insert_workflow_steps_one(
      object: {
        workflow_id: $workflowId
        position: $position
        type: $type
        name: $name
        config: $config
      }
    ) {
      id
      position
      type
      name
      config
    }
  }
`;

export const UPDATE_STEP = gql`
  mutation UpdateStep($id: uuid!, $set: workflow_steps_set_input!) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
      position
      name
      config
    }
  }
`;

export const DELETE_STEP = gql`
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) {
      id
    }
  }
`;

/**
 * Reorder as a two-row swap. Hasura runs both fields in a single transaction,
 * and workflow_steps' unique(workflow_id, position) constraint is DEFERRABLE,
 * so the transient collision midway through the swap is legal.
 */
export const SWAP_STEPS = gql`
  mutation SwapSteps($aId: uuid!, $aPos: Int!, $bId: uuid!, $bPos: Int!) {
    a: update_workflow_steps_by_pk(pk_columns: { id: $aId }, _set: { position: $aPos }) {
      id
      position
    }
    b: update_workflow_steps_by_pk(pk_columns: { id: $bId }, _set: { position: $bPos }) {
      id
      position
    }
  }
`;

export const ADD_TRIGGER = gql`
  mutation AddTrigger(
    $workflowId: uuid!
    $type: String!
    $config: jsonb!
    $cron: String
  ) {
    insert_workflow_triggers_one(
      object: { workflow_id: $workflowId, type: $type, config: $config, cron: $cron }
    ) {
      id
      type
      cron
      is_active
    }
  }
`;

export const DELETE_TRIGGER = gql`
  mutation DeleteTrigger($id: uuid!) {
    delete_workflow_triggers_by_pk(id: $id) {
      id
    }
  }
`;

/** Fires the database-event trigger. */
export const INSERT_WATCHED_RECORD = gql`
  mutation InsertWatchedRecord($orgId: uuid!, $kind: String!, $payload: jsonb!) {
    insert_watched_records_one(
      object: { org_id: $orgId, kind: $kind, payload: $payload }
    ) {
      id
      created_at
    }
  }
`;

/* ---------------------------------- actions ------------------------------- */

export const TRIGGER_WORKFLOW_RUN = gql`
  mutation TriggerWorkflowRun($workflowId: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflowId, input: $input) {
      run_id
      status
      message
      quota_used
      quota_limit
    }
  }
`;

export const APPROVE_STEP = gql`
  mutation ApproveStep($stepRunId: uuid!, $decision: ApprovalDecision!, $comment: String) {
    approveStep(step_run_id: $stepRunId, decision: $decision, comment: $comment) {
      step_run_id
      run_id
      run_status
      message
    }
  }
`;

export const GET_WEBHOOK_ENDPOINT = gql`
  query GetWebhookEndpoint($triggerId: uuid!) {
    getWebhookEndpoint(trigger_id: $triggerId) {
      trigger_id
      url
      method
      sample_curl
    }
  }
`;

/* ------------------------------- subscriptions ---------------------------- */

/**
 * Required subscription: live per-step progress for one run.
 *
 * Filtered to a workflow_run_id, but the isolation comes from the row
 * permission on step_runs, not this filter. Subscribing with another org's run
 * id yields an empty, permanently silent stream.
 */
export const STEP_RUNS_SUB = gql`
  subscription StepRuns($runId: uuid!) {
    step_runs(
      where: { workflow_run_id: { _eq: $runId } }
      order_by: { position: asc }
    ) {
      id
      position
      type
      name
      status
      output
      error
      attempt
      approved_by
      approved_at
      started_at
      finished_at
      approver {
        id
        displayName
      }
    }
  }
`;

export const RUN_SUB = gql`
  subscription RunStatus($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      error
      cursor
      trigger_type
      started_at
      finished_at
      context
      workflow {
        id
        name
        org_id
      }
    }
  }
`;

/** Live run list, so webhook/cron/event-started runs appear without a refresh. */
export const WORKFLOW_RUNS_SUB = gql`
  subscription WorkflowRuns($workflowId: uuid!) {
    workflow_runs(
      where: { workflow_id: { _eq: $workflowId } }
      order_by: { created_at: desc }
      limit: 12
    ) {
      id
      status
      trigger_type
      created_at
      started_at
      finished_at
      triggered_by_user {
        id
        displayName
      }
    }
  }
`;
