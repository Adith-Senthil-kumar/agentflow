#!/usr/bin/env node
/**
 * Clears run history and resets quota counters, so a demo or recording starts
 * from a clean slate. Organizations, members, workflows and triggers are left
 * alone — only execution history is removed.
 *
 *   npm run demo:reset
 */

import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

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

const URL_ = process.env.HASURA_GRAPHQL_URL;
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

async function gql(query, variables = {}) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

// step_runs, step_outputs and notifications all cascade from workflow_runs.
const cleared = await gql(`mutation {
  runs: delete_workflow_runs(where: {}) { affected_rows }
  records: delete_watched_records(where: {}) { affected_rows }
  quota: update_organizations(where: {}, _set: {quota_used: 0}) { affected_rows }
  fired: update_workflow_triggers(where: {}, _set: {last_fired_at: null}) { affected_rows }
}`);

const state = await gql(`query {
  organizations(order_by: {name: asc}) { name quota_used quota_limit }
}`);

console.log(
  `cleared ${cleared.runs.affected_rows} runs, ${cleared.records.affected_rows} watched records`,
);
for (const o of state.organizations) {
  console.log(`  ${o.name.padEnd(16)} quota ${o.quota_used}/${o.quota_limit}`);
}
console.log('\nready for a clean take.');
