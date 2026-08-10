#!/usr/bin/env node
/**
 * Starts a run the way an external system would: by POSTing the
 * triggerWorkflowByWebhook Action with a trigger's token. No user session, no
 * workflow id — the token is the only thing that resolves the target.
 *
 *   npm run demo:webhook                      # urgent alert, takes the branch
 *   npm run demo:webhook -- "Coffee machine is out of beans"
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
const subject = process.argv[2] || 'Production database is down, checkout is failing';

async function gql(query, variables, admin = false) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(admin ? { 'x-hasura-admin-secret': ADMIN_SECRET } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// The admin secret is used only to look up the demo token, exactly as an owner
// would have copied it out of the UI. The call itself is unauthenticated.
const lookup = await gql(
  `query {
     workflow_triggers(where: {type: {_eq: "webhook"}, workflow: {name: {_eq: "Incident triage"}}}, limit: 1) {
       webhook_token
     }
   }`,
  {},
  true,
);

const token = lookup.data?.workflow_triggers?.[0]?.webhook_token;
if (!token) {
  console.error('No webhook trigger found. Run `npm run seed` first.');
  process.exit(1);
}

console.log(`POST ${HASURA_URL}`);
console.log(`  (unauthenticated — no admin secret, no user JWT)`);
console.log(`  subject: ${subject}\n`);

const result = await gql(
  `mutation ($t: String!, $p: jsonb) {
     triggerWorkflowByWebhook(webhook_token: $t, payload: $p) {
       run_id
       status
       message
       quota_used
       quota_limit
     }
   }`,
  { t: token, p: { subject, source: 'external-system' } },
);

console.log(JSON.stringify(result, null, 2));

const runId = result.data?.triggerWorkflowByWebhook?.run_id;
if (runId) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  console.log(`\nWatch it live: ${base}/run/${runId}\n`);
}
