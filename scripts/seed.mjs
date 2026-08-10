#!/usr/bin/env node
/**
 * Seeds the two-organization demo scenario.
 *
 * Idempotent: demo orgs are dropped and rebuilt (cascading to their workflows
 * and runs), while auth users are created once and reused.
 *
 * Everything here runs with the admin secret. That is the point — it is the
 * only way to create the *first* owner of an organization, since the insert
 * permission on org_members requires an existing owner of that same org.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, k, rawV] = m;
      if (process.env[k]) continue;
      let v = rawV.trim();
      if (
        (v.startsWith("'") && v.endsWith("'")) ||
        (v.startsWith('"') && v.endsWith('"'))
      ) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
    }
  } catch {
    /* file is optional */
  }
}

const HASURA_URL = process.env.HASURA_GRAPHQL_URL;
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
const SUBDOMAIN = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
const REGION = process.env.NEXT_PUBLIC_NHOST_REGION;
const AUTH_URL = `https://${SUBDOMAIN}.auth.${REGION}.nhost.run/v1`;

if (!HASURA_URL || !ADMIN_SECRET || !SUBDOMAIN || !REGION) {
  console.error(
    'Missing env. Need HASURA_GRAPHQL_URL, HASURA_GRAPHQL_ADMIN_SECRET, NEXT_PUBLIC_NHOST_SUBDOMAIN, NEXT_PUBLIC_NHOST_REGION.',
  );
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD || 'Password123!';

async function gql(query, variables = {}) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

/** Creates the user if needed, then makes sure they can actually sign in. */
async function ensureUser(email, displayName) {
  const existing = await gql(
    `query ($email: citext!) { users(where: {email: {_eq: $email}}) { id } }`,
    { email },
  );
  let id = existing.users[0]?.id;

  if (!id) {
    const res = await fetch(`${AUTH_URL}/signup/email-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, options: { displayName } }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sign-up failed for ${email}: ${res.status} ${body}`);
    }
    const again = await gql(
      `query ($email: citext!) { users(where: {email: {_eq: $email}}) { id } }`,
      { email },
    );
    id = again.users[0]?.id;
    if (!id) throw new Error(`User ${email} was not created`);
  }

  // The project may require email verification; these are throwaway demo
  // addresses with no inbox, so mark them verified directly.
  await gql(
    `mutation ($id: uuid!, $name: String!) {
       updateUser(pk_columns: {id: $id}, _set: {emailVerified: true, disabled: false, displayName: $name}) { id }
     }`,
    { id, name: displayName },
  );

  return id;
}

async function main() {
  console.log('→ creating demo users');
  const users = {
    ownerA: await ensureUser('owner-a@agentflow.test', 'Ada Lovelace'),
    editorA: await ensureUser('editor-a@agentflow.test', 'Edgar Codd'),
    viewerA: await ensureUser('viewer-a@agentflow.test', 'Vera Rubin'),
    ownerB: await ensureUser('owner-b@agentflow.test', 'Boris Novak'),
  };

  console.log('→ resetting demo organizations');
  await gql(
    `mutation ($slugs: [String!]!) {
       delete_organizations(where: {slug: {_in: $slugs}}) { affected_rows }
     }`,
    { slugs: ['acme-robotics', 'northwind-labs'] },
  );

  const { insert_organizations: orgs } = await gql(
    `mutation ($objects: [organizations_insert_input!]!) {
       insert_organizations(objects: $objects) { returning { id slug name } }
     }`,
    {
      objects: [
        { name: 'Acme Robotics', slug: 'acme-robotics', quota_limit: 50 },
        { name: 'Northwind Labs', slug: 'northwind-labs', quota_limit: 25 },
      ],
    },
  );

  const orgA = orgs.returning.find((o) => o.slug === 'acme-robotics');
  const orgB = orgs.returning.find((o) => o.slug === 'northwind-labs');

  console.log('→ assigning memberships');
  await gql(
    `mutation ($objects: [org_members_insert_input!]!) {
       insert_org_members(objects: $objects) { affected_rows }
     }`,
    {
      objects: [
        { org_id: orgA.id, user_id: users.ownerA, role: 'owner' },
        { org_id: orgA.id, user_id: users.editorA, role: 'editor' },
        { org_id: orgA.id, user_id: users.viewerA, role: 'viewer' },
        { org_id: orgB.id, user_id: users.ownerB, role: 'owner' },
      ],
    },
  );

  console.log('→ building Org A workflows');

  // The Final Task workflow: llm_call -> conditional_branch -> http_request
  // -> approval_gate -> db_write. The branch reads the LLM's verdict, so a
  // NORMAL classification ends the run before the approval gate is ever
  // reached and the later steps are marked `skipped`.
  const triage = await createWorkflow({
    orgId: orgA.id,
    createdBy: users.ownerA,
    name: 'Incident triage',
    description:
      'Classify an inbound alert with an LLM, branch on the verdict, enrich it from an external API, pause for human approval, then record the outcome.',
    steps: [
      {
        position: 0,
        type: 'llm_call',
        name: 'Classify alert',
        config: {
          system:
            'You are an incident triage assistant. Reply with exactly one word first — URGENT or NORMAL — then one short sentence of justification.',
          prompt:
            'Classify this alert and justify briefly:\n\n{{trigger.subject}}',
          temperature: 0.1,
          max_tokens: 120,
        },
      },
      {
        position: 1,
        type: 'conditional_branch',
        name: 'Urgent?',
        config: {
          left: '{{steps.Classify alert.text}}',
          operator: 'contains',
          right: 'URGENT',
          on_true: { action: 'continue' },
          on_false: { action: 'end' },
        },
      },
      {
        position: 2,
        type: 'http_request',
        name: 'Fetch incident record',
        config: {
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/posts/1',
          timeout_ms: 15000,
        },
      },
      {
        position: 3,
        type: 'approval_gate',
        name: 'Human approval',
        config: {
          instructions:
            'This alert was classified URGENT. An owner or editor must approve before it is recorded and escalated.',
          allowed_roles: ['owner', 'editor'],
        },
      },
      {
        position: 4,
        type: 'db_write',
        name: 'Record triage result',
        config: {
          key: 'triage_result',
          value: '{{steps.Classify alert.text}}',
        },
      },
    ],
    triggers: [
      { type: 'webhook', config: {} },
      { type: 'database_event', config: { kind: 'lead' } },
    ],
  });

  // No owner-only step types, so an editor can start this one — which is how
  // the trigger-side step gate shows up as a difference rather than a rule
  // nobody can observe.
  await createWorkflow({
    orgId: orgA.id,
    createdBy: users.ownerA,
    name: 'Lead enrichment (editor-runnable)',
    description:
      'Contains no owner-only step types, so an editor can trigger it as well as an owner.',
    steps: [
      {
        position: 0,
        type: 'llm_call',
        name: 'Summarise lead',
        config: {
          system: 'You write one-sentence CRM summaries.',
          prompt: 'Summarise this inbound lead in one sentence:\n\n{{trigger.subject}}',
          temperature: 0.3,
          max_tokens: 100,
        },
      },
      {
        position: 1,
        type: 'http_request',
        name: 'Fetch enrichment data',
        config: {
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/users/1',
          timeout_ms: 15000,
        },
      },
    ],
    triggers: [{ type: 'scheduled', config: {}, cron: '*/5 * * * *' }],
  });

  console.log('→ building Org B workflow');
  await createWorkflow({
    orgId: orgB.id,
    createdBy: users.ownerB,
    name: 'Northwind weekly digest',
    description: 'Belongs to Org B. Org A users cannot see, run, or approve any part of it.',
    steps: [
      {
        position: 0,
        type: 'llm_call',
        name: 'Draft digest',
        config: {
          system: 'You write concise internal updates.',
          prompt: 'Write a two-line weekly engineering digest for Northwind Labs.',
          temperature: 0.4,
          max_tokens: 120,
        },
      },
    ],
    triggers: [],
  });

  const token = await gql(
    `query ($id: uuid!) {
       workflow_triggers(where: {workflow_id: {_eq: $id}, type: {_eq: "webhook"}}) { webhook_token }
     }`,
    { id: triage.id },
  );

  console.log(`
✔ seed complete

  Org A  Acme Robotics    ${orgA.id}
  Org B  Northwind Labs   ${orgB.id}

  owner-a@agentflow.test   owner  in Org A
  editor-a@agentflow.test  editor in Org A
  viewer-a@agentflow.test  viewer in Org A
  owner-b@agentflow.test   owner  in Org B
  password for all:        ${PASSWORD}

  Incident triage workflow: ${triage.id}
  Webhook token:            ${token.workflow_triggers[0]?.webhook_token ?? '(none)'}

  Fire the webhook trigger with:

    npm run demo:webhook
`);
}

async function createWorkflow({ orgId, createdBy, name, description, steps, triggers }) {
  const data = await gql(
    `mutation ($object: workflows_insert_input!) {
       insert_workflows_one(object: $object) { id name }
     }`,
    {
      object: {
        org_id: orgId,
        created_by: createdBy,
        name,
        description,
        steps: { data: steps },
        triggers: { data: triggers },
      },
    },
  );
  return data.insert_workflows_one;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
