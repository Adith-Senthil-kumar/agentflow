#!/usr/bin/env node
/**
 * Automated proof of the two permission layers.
 *
 * Signs in as four real users (three roles in Org A, one owner in Org B) and
 * drives the public GraphQL endpoint with their actual JWTs — no admin secret
 * anywhere below the setup block. Every assertion is something a reviewer could
 * try by hand in the browser console.
 *
 *   npm run verify
 */

import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Some networks resolve nhost to an IPv6 address that Node reaches less
// reliably than curl does. Prefer IPv4 so the suite behaves the same everywhere.
setDefaultResultOrder('ipv4first');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, k, rawV] = m;
      if (process.env[k]) continue;
      let v = rawV.trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

const HASURA_URL = process.env.HASURA_GRAPHQL_URL;
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
const AUTH_URL = `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.auth.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1`;
const PASSWORD = process.env.SEED_PASSWORD || 'Password123!';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function gql(token, query, variables = {}) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === 'ADMIN'
        ? { 'x-hasura-admin-secret': ADMIN_SECRET }
        : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signs in, retrying on transport errors and empty bodies.
 *
 * nhost rate-limits its auth endpoints, and this script signs four users in
 * every time it runs, so a burst of consecutive runs can trip the limit and get
 * a closed socket rather than a clean error. Backing off keeps the suite
 * dependable enough to run repeatedly.
 */
async function signIn(email, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${AUTH_URL}/signin/email-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      const text = await res.text();
      if (!text) throw new Error(`empty response (HTTP ${res.status})`);
      const body = JSON.parse(text);
      const token = body?.session?.accessToken;
      if (!token) throw new Error(JSON.stringify(body));
      return token;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(3000 * attempt);
    }
  }
  throw new Error(`Could not sign in as ${email} after ${attempts} attempts: ${lastError}`);
}

const isPermissionError = (r) =>
  !!r.errors &&
  JSON.stringify(r.errors).match(/permission|not found|no queries available|constraint/i);

async function main() {
  console.log('\nSigning in as the four demo users…');
  // Spaced out: nhost rate-limits auth per IP, and four sign-ins back to back
  // from a machine that has already run this suite a few times can trip it.
  const ownerA = await signIn('owner-a@agentflow.test');
  await sleep(1200);
  const editorA = await signIn('editor-a@agentflow.test');
  await sleep(1200);
  const viewerA = await signIn('viewer-a@agentflow.test');
  await sleep(1200);
  const ownerB = await signIn('owner-b@agentflow.test');

  // Setup uses admin only to *find* the ids an attacker would be guessing.
  const setup = await gql(
    'ADMIN',
    `query {
       a: workflows(where: {name: {_eq: "Incident triage"}}) { id org_id }
       b: workflows(where: {name: {_eq: "Northwind weekly digest"}}) { id org_id }
       runs: workflow_runs(order_by: {created_at: desc}, limit: 1) { id }
       gate: step_runs(where: {type: {_eq: "approval_gate"}}, order_by: {created_at: desc}, limit: 1) { id }
     }`,
  );
  const wfA = setup.data.a[0];
  const wfB = setup.data.b[0];
  const runA = setup.data.runs[0];
  const gateA = setup.data.gate[0];

  console.log(`\nOrg A workflow ${wfA.id}\nOrg B workflow ${wfB.id}\n`);

  /* ------------------------------------------------------------------ */
  console.log('LAYER 1 — cross-org isolation, by direct id');

  let r = await gql(ownerB, `query ($id: uuid!) { workflows_by_pk(id: $id) { id name } }`, {
    id: wfA.id,
  });
  check(
    'Org B owner cannot read an Org A workflow by its exact id',
    r.data?.workflows_by_pk === null,
    JSON.stringify(r),
  );

  r = await gql(ownerB, `query ($id: uuid!) { workflow_runs_by_pk(id: $id) { id status } }`, {
    id: runA.id,
  });
  check(
    'Org B owner cannot read an Org A run by its exact id',
    r.data?.workflow_runs_by_pk === null,
    JSON.stringify(r),
  );

  r = await gql(
    ownerB,
    `query ($id: uuid!) { step_runs(where: {workflow_run_id: {_eq: $id}}) { id status } }`,
    { id: runA.id },
  );
  check(
    'Org B owner gets an empty step_runs set for an Org A run (same filter the subscription uses)',
    Array.isArray(r.data?.step_runs) && r.data.step_runs.length === 0,
    JSON.stringify(r),
  );

  r = await gql(ownerB, `query { workflows { id name } }`);
  check(
    'Org B owner listing workflows sees only their own',
    r.data?.workflows?.every((w) => w.id !== wfA.id) && r.data.workflows.length > 0,
    JSON.stringify(r),
  );

  r = await gql(ownerB, `query { organizations { id name } }`);
  check(
    'Org B owner sees exactly one organization',
    r.data?.organizations?.length === 1 && r.data.organizations[0].id === wfB.org_id,
    JSON.stringify(r),
  );

  r = await gql(
    ownerB,
    `mutation ($id: uuid!) {
       update_workflows_by_pk(pk_columns: {id: $id}, _set: {name: "pwned"}) { id name }
     }`,
    { id: wfA.id },
  );
  check(
    'Org B owner cannot rename an Org A workflow',
    r.data?.update_workflows_by_pk === null || isPermissionError(r),
    JSON.stringify(r),
  );

  r = await gql(
    ownerB,
    `mutation ($wf: uuid!) {
       insert_workflow_steps_one(object: {workflow_id: $wf, position: 99, type: "llm_call", name: "injected", config: {}}) { id }
     }`,
    { wf: wfA.id },
  );
  check(
    'Org B owner cannot inject a step into an Org A workflow',
    isPermissionError(r),
    JSON.stringify(r),
  );

  /* ------------------------------------------------------------------ */
  console.log('\nLAYER 1 — role scoping inside one org');

  r = await gql(
    viewerA,
    `mutation ($org: uuid!) {
       insert_workflows_one(object: {org_id: $org, name: "viewer made this"}) { id }
     }`,
    { org: wfA.org_id },
  );
  check('Org A viewer cannot create a workflow', isPermissionError(r), JSON.stringify(r));

  r = await gql(
    viewerA,
    `mutation ($wf: uuid!, $org: uuid!) {
       insert_workflow_runs_one(object: {workflow_id: $wf, org_id: $org, trigger_type: "manual"}) { id }
     }`,
    { wf: wfA.id, org: wfA.org_id },
  );
  check(
    'Org A viewer cannot insert a workflow_run directly (bypassing the Run button)',
    isPermissionError(r),
    JSON.stringify(r),
  );

  r = await gql(
    editorA,
    `mutation ($org: uuid!, $user: uuid!) {
       insert_org_members_one(object: {org_id: $org, user_id: $user, role: "owner"}) { id }
     }`,
    { org: wfA.org_id, user: '00000000-0000-0000-0000-000000000001' },
  );
  check('Org A editor cannot manage org membership', isPermissionError(r), JSON.stringify(r));

  r = await gql(viewerA, `query ($id: uuid!) { workflows_by_pk(id: $id) { id name } }`, {
    id: wfA.id,
  });
  check(
    'Org A viewer CAN read their own org workflow (read-only, not blind)',
    r.data?.workflows_by_pk?.id === wfA.id,
    JSON.stringify(r),
  );

  /* ------------------------------------------------------------------ */
  console.log('\nLAYER 2 — step-level gating');

  r = await gql(
    editorA,
    `mutation ($wf: uuid!) {
       insert_workflow_steps_one(object: {workflow_id: $wf, position: 90, type: "db_write", name: "editor db_write", config: {key: "x"}}) { id }
     }`,
    { wf: wfA.id },
  );
  check(
    'Org A editor cannot add a db_write step (owner_only)',
    isPermissionError(r),
    JSON.stringify(r),
  );

  r = await gql(
    editorA,
    `mutation ($wf: uuid!) {
       insert_workflow_steps_one(object: {workflow_id: $wf, position: 91, type: "notify", name: "editor notify", config: {body: "x"}}) { id }
     }`,
    { wf: wfA.id },
  );
  check(
    'Org A editor cannot add a notify step (owner_only)',
    isPermissionError(r),
    JSON.stringify(r),
  );

  r = await gql(
    editorA,
    `mutation ($wf: uuid!) {
       insert_workflow_triggers_one(object: {workflow_id: $wf, type: "webhook", config: {}}) { id }
     }`,
    { wf: wfA.id },
  );
  check(
    'Org A editor cannot attach a webhook trigger (owner_only)',
    isPermissionError(r),
    JSON.stringify(r),
  );

  r = await gql(
    editorA,
    `mutation ($wf: uuid!) {
       insert_workflow_steps_one(object: {workflow_id: $wf, position: 92, type: "llm_call", name: "editor llm step", config: {prompt: "hi"}}) { id }
     }`,
    { wf: wfA.id },
  );
  const createdStepId = r.data?.insert_workflow_steps_one?.id;
  check(
    'Org A editor CAN add an llm_call step (not owner_only)',
    !!createdStepId,
    JSON.stringify(r),
  );

  if (createdStepId) {
    r = await gql(
      editorA,
      `mutation ($id: uuid!) {
         update_workflow_steps_by_pk(pk_columns: {id: $id}, _set: {type: "db_write"}) { id type }
       }`,
      { id: createdStepId },
    );
    check(
      'Org A editor cannot escalate that step into a db_write by updating its type',
      isPermissionError(r) || r.data?.update_workflow_steps_by_pk?.type !== 'db_write',
      JSON.stringify(r),
    );
    await gql(editorA, `mutation ($id: uuid!) { delete_workflow_steps_by_pk(id: $id) { id } }`, {
      id: createdStepId,
    });
  }

  r = await gql(ownerA, `query { workflow_triggers { id webhook_token } }`);
  check(
    'webhook_token is not a selectable column for any client role, even an owner',
    !!r.errors && /webhook_token/.test(JSON.stringify(r.errors)),
    JSON.stringify(r).slice(0, 200),
  );

  /* ------------------------------------------------------------------ */
  console.log('\nAPPROVAL GATE — writable only through the Action');

  if (gateA) {
    r = await gql(
      editorA,
      `mutation ($id: uuid!, $me: uuid!) {
         update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "succeeded", approved_by: $me}) { id }
       }`,
      { id: gateA.id, me: '00000000-0000-0000-0000-000000000001' },
    );
    check(
      'Even an Org A editor cannot approve by writing to step_runs directly',
      isPermissionError(r),
      JSON.stringify(r),
    );
  }

  r = await gql(
    ownerB,
    `mutation ($id: uuid!) {
       approveStep(step_run_id: $id, decision: approve) { run_status }
     }`,
    { id: gateA?.id ?? '00000000-0000-0000-0000-000000000001' },
  );
  check(
    'Org B owner calling approveStep on an Org A step is refused without revealing it exists',
    !!r.errors && /not found, or you do not have access/i.test(JSON.stringify(r.errors)),
    JSON.stringify(r).slice(0, 300),
  );

  r = await gql(ownerB, `mutation ($id: uuid!) { triggerWorkflowRun(workflow_id: $id) { run_id } }`, {
    id: wfA.id,
  });
  check(
    'Org B owner calling triggerWorkflowRun on an Org A workflow is refused',
    !!r.errors && /not found, or you do not have access/i.test(JSON.stringify(r.errors)),
    JSON.stringify(r).slice(0, 300),
  );

  r = await gql(viewerA, `mutation ($id: uuid!) { triggerWorkflowRun(workflow_id: $id) { run_id } }`, {
    id: wfA.id,
  });
  check(
    'Org A viewer calling triggerWorkflowRun is refused',
    !!r.errors && /viewers cannot trigger/i.test(JSON.stringify(r.errors)),
    JSON.stringify(r).slice(0, 300),
  );

  /* ------------------------------------------------------------------ */
  console.log(
    `\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
