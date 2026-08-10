#!/usr/bin/env node
/**
 * Records the Final Task scenario against the *live deployed* app.
 *
 * Nothing here is mocked: it signs in as the real demo users, presses the real
 * Run button, waits on the real GraphQL subscription, and approves through the
 * real Action. Two browser contexts run at once so the approval visibly happens
 * in one window while the other advances on its own.
 *
 *   node scripts/record-demo.mjs
 *
 * Produces raw per-context .webm files under recordings/. Stitching them into a
 * single side-by-side MP4 is done afterwards by scripts/stitch-demo.sh.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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

const APP = process.env.APP_URL || 'https://agentflow-beta-jet.vercel.app';
const HASURA_URL = process.env.HASURA_GRAPHQL_URL;
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
const PASSWORD = process.env.SEED_PASSWORD || 'Password123!';
const OUT = join(ROOT, 'recordings');
const VIEWPORT = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gqlAdmin(query, variables = {}) {
  const res = await fetch(HASURA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function signIn(page, email) {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('text=Your organizations', { timeout: 30_000 });
  await sleep(900);
}

/**
 * Pins a persistent role badge to every page in a context, re-applied on each
 * navigation, so a viewer always knows which window they are looking at.
 */
async function badge(context, text, color) {
  await context.addInitScript(
    ({ text, color }) => {
      const paint = () => {
        if (document.getElementById('__demo_badge')) return;
        const el = document.createElement('div');
        el.id = '__demo_badge';
        Object.assign(el.style, {
          position: 'fixed',
          top: '0',
          left: '0',
          zIndex: '99999',
          padding: '9px 16px',
          background: color,
          color: '#000',
          font: '700 15px/1 ui-monospace, monospace',
          letterSpacing: '0.08em',
        });
        el.textContent = text;
        document.body.appendChild(el);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', paint);
      } else {
        paint();
      }
      setInterval(paint, 500);
    },
    { text, color },
  );
}

/** Types a caption into the page so the video explains itself without audio. */
async function caption(page, text, ms = 2600) {
  await page.evaluate((t) => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      Object.assign(el.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: '99999',
        padding: '14px 22px',
        background: 'rgba(255,176,0,0.96)',
        color: '#000',
        font: '600 17px/1.35 ui-monospace, monospace',
        letterSpacing: '0.01em',
        boxShadow: '0 -8px 24px rgba(0,0,0,0.5)',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await sleep(ms);
}

async function clearCaption(page) {
  await page.evaluate(() => document.getElementById('__demo_caption')?.remove());
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();

  const ownerCtx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, 'owner'), size: VIEWPORT },
    colorScheme: 'dark',
  });
  const editorCtx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, 'editor'), size: VIEWPORT },
    colorScheme: 'dark',
  });

  await badge(ownerCtx, 'ORG A — OWNER', '#FFB000');
  await badge(editorCtx, 'ORG A — EDITOR', '#35D0A5');

  const owner = await ownerCtx.newPage();
  const editor = await editorCtx.newPage();

  // ---------------------------------------------------------------- 1 & 2
  console.log('→ signing in as the Org A owner');
  await signIn(owner, 'owner-a@agentflow.test');
  await caption(owner, 'ORG A — signed in as owner-a. This list is permission-filtered.', 3000);

  await owner.click('text=Acme Robotics');
  await owner.waitForSelector('text=Incident triage', { timeout: 30_000 });
  await caption(owner, 'Org A workflows. Quota meter top right.', 2600);

  await owner.click('text=Incident triage');
  await owner.waitForSelector('text=Classify alert', { timeout: 30_000 });
  await caption(
    owner,
    'Six steps: llm_call → conditional_branch → http_request → approval_gate → db_write → notify',
    4200,
  );

  // Editor signs in while the owner is reading, so both windows are live.
  console.log('→ signing in as the Org A editor');
  await sleep(1500);
  await signIn(editor, 'editor-a@agentflow.test');
  await caption(editor, 'ORG A — a second browser, signed in as editor-a.', 2600);

  // ---------------------------------------------------------------- 3 & 5
  console.log('→ pressing Run');
  await clearCaption(owner);
  await owner.click('button:has-text("run workflow")');
  await owner.waitForURL(/\/run\//, { timeout: 30_000 });
  const runUrl = owner.url();
  const runId = runUrl.split('/run/')[1];
  console.log('   run', runId);

  await caption(
    owner,
    'Run started. Steps stream in live over a GraphQL subscription — nothing polls or refreshes.',
    3000,
  );
  await clearCaption(owner);

  // Watch it actually progress, on camera.
  await owner.waitForSelector('text=awaiting approval', { timeout: 120_000 });
  await caption(owner, 'PAUSED at the approval gate. The LLM classified this alert URGENT.', 3400);

  // ---------------------------------------------------------------- 4
  console.log('→ editor opens the same run and approves');
  await editor.goto(`${APP}/run/${runId}`, { waitUntil: 'networkidle' });
  await editor.waitForSelector('text=awaiting approval', { timeout: 60_000 });
  await caption(
    editor,
    'The editor sees the same paused run, and is allowed to approve it.',
    3200,
  );
  await clearCaption(editor);

  await clearCaption(owner);
  await caption(owner, 'Watch this window — it will resume on its own.', 2200);
  await clearCaption(owner);

  await editor.fill('input[placeholder="optional comment"]', 'Confirmed urgent — escalate');
  await sleep(700);
  await editor.click('button:has-text("approve & resume")');
  await caption(editor, 'Approved. approveStep checked this user’s role in THIS org first.', 3000);

  // The owner window should now advance with no interaction at all.
  await owner.waitForSelector('text=succeeded', { timeout: 120_000 });
  await sleep(2500);
  await caption(
    owner,
    'Resumed and finished — db_write and notify ran. No click, no refresh in this window.',
    4200,
  );
  await clearCaption(owner);
  await clearCaption(editor);

  await ownerCtx.close();
  await editorCtx.close();

  // ---------------------------------------------------------------- 6
  console.log('→ Org B isolation');
  const orgBCtx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, 'orgb'), size: VIEWPORT },
    colorScheme: 'dark',
  });
  await badge(orgBCtx, 'ORG B — OWNER', '#FF5C53');
  const orgB = await orgBCtx.newPage();

  await signIn(orgB, 'owner-b@agentflow.test');
  await caption(orgB, 'ORG B — a different organization entirely. Only its own org is listed.', 3200);

  const ids = await gqlAdmin(`query {
    wf: workflows(where: {name: {_eq: "Incident triage"}}) { id org_id }
  }`);
  const wfA = ids.data.wf[0];

  await clearCaption(orgB);
  await orgB.goto(`${APP}/run/${runId}`, { waitUntil: 'networkidle' });
  await caption(orgB, `Pasting Org A’s run id directly: /run/${runId.slice(0, 8)}…`, 3600);
  await sleep(1200);

  await clearCaption(orgB);
  await orgB.goto(`${APP}/org/${wfA.org_id}/workflow/${wfA.id}`, { waitUntil: 'networkidle' });
  await caption(orgB, 'And Org A’s workflow id directly. Same answer — the row permission returns nothing.', 4200);

  await clearCaption(orgB);
  await orgBCtx.close();
  await browser.close();

  console.log(`\n✔ raw videos in ${OUT}`);
  console.log('  next: bash scripts/stitch-demo.sh');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
