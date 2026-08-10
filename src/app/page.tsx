'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AppShell, useMyOrgs } from '@/components/app-shell';
import { useAuth } from '@/components/providers';
import { Button, ErrorNote, Field, Input, Label, Panel, Spinner } from '@/components/ui';
import { nhost } from '@/lib/nhost-client';

export default function Home() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="restoring session" />
      </div>
    );
  }

  return session ? <OrgPicker /> : <SignIn />;
}

/* -------------------------------------------------------------------------- */

function SignIn() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await nhost.auth.signInEmailPassword({ email, password });
      } else {
        const res = await nhost.auth.signUpEmailPassword({
          email,
          password,
          options: { displayName: displayName || email },
        });
        if (!res.body?.session) {
          setNotice(
            'Account created. Email verification is enabled on this project, so check your inbox before signing in.',
          );
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-[880px]">
        <div className="mb-10 flex items-end justify-between gap-8 border-b border-[var(--color-line)] pb-6">
          <div>
            <h1 className="font-[family-name:var(--font-mono)] text-[34px] leading-none font-bold tracking-[-0.03em] text-[var(--color-amber)] sm:text-[46px]">
              AGENTFLOW
            </h1>
            <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
              A multi-tenant engine for chaining AI agent steps. Workflows belong to
              organizations; every read and every action is scoped by org membership and role.
            </p>
          </div>
          <div className="hidden text-right sm:block">
            <Label>stack</Label>
            <p className="font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              nhost · hasura
              <br />
              postgres · graphql
            </p>
          </div>
        </div>

        <div className="grid gap-8 md:grid-cols-[1fr_320px]">
          <Panel className="p-6">
            <div className="mb-5 flex gap-1">
              {(['signin', 'signup'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setError(null);
                    setNotice(null);
                  }}
                  className={`border px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.1em] transition-colors ${
                    mode === m
                      ? 'border-[var(--color-amber)] text-[var(--color-amber)]'
                      : 'border-[var(--color-line)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]'
                  }`}
                >
                  {m === 'signin' ? 'sign in' : 'create account'}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-4">
              {mode === 'signup' ? (
                <Field label="display name">
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Ada Lovelace"
                    autoComplete="name"
                  />
                </Field>
              ) : null}

              <Field label="email">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </Field>

              <Field label="password">
                <Input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                />
              </Field>

              {error ? <ErrorNote>{error}</ErrorNote> : null}
              {notice ? (
                <p className="border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/8 px-3 py-2 text-[12px] leading-relaxed text-[var(--color-warn)]">
                  {notice}
                </p>
              ) : null}

              <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
                {busy ? 'working…' : mode === 'signin' ? 'sign in' : 'create account'}
              </Button>
            </form>
          </Panel>

          <Panel className="p-6">
            <Label>demo accounts</Label>
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">
              Two separate organizations with their own users. Sign in as an Org B user to
              confirm that nothing belonging to Org A is reachable — not even by pasting an
              id into the URL.
            </p>
            <dl className="mt-4 space-y-3 font-[family-name:var(--font-mono)] text-[11px]">
              {[
                ['Org A · owner', 'owner-a@agentflow.test'],
                ['Org A · editor', 'editor-a@agentflow.test'],
                ['Org A · viewer', 'viewer-a@agentflow.test'],
                ['Org B · owner', 'owner-b@agentflow.test'],
              ].map(([role, addr]) => (
                <div key={addr}>
                  <dt className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                    {role}
                  </dt>
                  <dd className="text-[var(--color-ink-dim)]">{addr}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 border-t border-[var(--color-line)] pt-3 text-[11px] text-[var(--color-ink-faint)]">
              password for all: <span className="text-[var(--color-ink-dim)]">Password123!</span>
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function OrgPicker() {
  const { memberships, loading } = useMyOrgs();

  return (
    <AppShell>
      <h1 className="font-[family-name:var(--font-mono)] text-[22px] font-bold tracking-[-0.02em]">
        Your organizations
      </h1>
      <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
        This list comes straight from a permission-filtered query — it contains exactly the orgs
        you hold a membership row for.
      </p>

      {loading ? <Spinner /> : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {memberships.map((m, i) => (
          <Link key={m.org.id} href={`/org/${m.org.id}`} className="rise block" style={{ animationDelay: `${i * 60}ms` }}>
            <Panel className="group h-full p-5 transition-colors hover:border-[var(--color-amber)]">
              <Label>{m.role}</Label>
              <h2 className="mt-2 font-[family-name:var(--font-mono)] text-[16px] text-[var(--color-ink)]">
                {m.org.name}
              </h2>
              <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">/{m.org.slug}</p>
              <span className="mt-4 inline-block font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-faint)] transition-colors group-hover:text-[var(--color-amber)]">
                open →
              </span>
            </Panel>
          </Link>
        ))}
      </div>

      {!loading && memberships.length === 0 ? (
        <Panel className="mt-8 p-6">
          <p className="text-[13px] leading-relaxed text-[var(--color-ink-dim)]">
            You are not a member of any organization yet. Ask an owner to add you, or run the
            seed script described in the README to create the two demo orgs.
          </p>
        </Panel>
      ) : null}
    </AppShell>
  );
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as { body?: { message?: string }; message?: string };
    return anyErr.body?.message ?? anyErr.message ?? 'Something went wrong';
  }
  return String(err);
}
