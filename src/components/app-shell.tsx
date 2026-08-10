'use client';

import { useQuery } from '@apollo/client/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { MY_ORGS, ORG_USAGE } from '@/lib/gql';
import type { OrgRole } from '@/lib/types';
import { useAuth } from './providers';
import { Label } from './ui';

export interface MembershipRow {
  id: string;
  role: OrgRole;
  org: { id: string; name: string; slug: string };
}

export function useMyOrgs() {
  const { userId } = useAuth();
  const { data, loading, error } = useQuery<{ org_members: MembershipRow[] }>(MY_ORGS, {
    variables: { userId },
    skip: !userId,
  });
  return { memberships: data?.org_members ?? [], loading: loading || !userId, error };
}

/** The caller's role in one org, or null when they are not a member of it. */
export function useOrgRole(orgId?: string | null): OrgRole | null {
  const { memberships } = useMyOrgs();
  if (!orgId) return null;
  return memberships.find((m) => m.org.id === orgId)?.role ?? null;
}

function QuotaMeter({ orgId }: { orgId: string }) {
  const { data } = useQuery<{
    org_usage_current_month: {
      quota_used: number;
      quota_limit: number;
      quota_remaining: number;
      runs_this_month: number;
      avg_run_seconds: number | null;
    }[];
  }>(ORG_USAGE, { variables: { orgId }, pollInterval: 10_000 });

  const usage = data?.org_usage_current_month?.[0];
  if (!usage) return null;

  const pct = usage.quota_limit ? Math.min(100, (usage.quota_used / usage.quota_limit) * 100) : 0;
  const critical = usage.quota_remaining === 0;
  const tight = !critical && pct >= 80;
  const color = critical
    ? 'var(--color-fail)'
    : tight
      ? 'var(--color-warn)'
      : 'var(--color-live)';

  return (
    <div
      className="flex items-center gap-3"
      title={`${usage.runs_this_month} runs this month · avg ${usage.avg_run_seconds ?? '—'}s`}
    >
      <div className="text-right">
        <Label>quota</Label>
        <div className="font-[family-name:var(--font-mono)] text-[12px] leading-tight text-[var(--color-ink)]">
          {usage.quota_used}
          <span className="text-[var(--color-ink-faint)]">/{usage.quota_limit}</span>
        </div>
      </div>
      <div className="h-8 w-24 border border-[var(--color-line-bright)] p-[3px]">
        <div className="h-full w-full bg-[var(--color-void)]">
          <div
            className="h-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { email, signOut } = useAuth();
  const { memberships } = useMyOrgs();
  const params = useParams<{ orgId?: string }>();
  const pathname = usePathname();

  const activeOrgId =
    params?.orgId ?? memberships.find((m) => pathname.includes(m.org.id))?.org.id;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-void)]/92 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
          <Link href="/" className="group flex items-baseline gap-2">
            <span className="font-[family-name:var(--font-mono)] text-[15px] font-bold tracking-[-0.02em] text-[var(--color-amber)]">
              AGENTFLOW
            </span>
            <span className="hidden font-[family-name:var(--font-mono)] text-[10px] tracking-[0.14em] text-[var(--color-ink-faint)] sm:inline">
              WORKFLOW CONTROL
            </span>
          </Link>

          {memberships.length > 0 ? (
            <nav className="flex items-center gap-1 overflow-x-auto">
              {memberships.map((m) => {
                const active = m.org.id === activeOrgId;
                return (
                  <Link
                    key={m.org.id}
                    href={`/org/${m.org.id}`}
                    className={`whitespace-nowrap border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
                      active
                        ? 'border-[var(--color-amber)] text-[var(--color-amber)]'
                        : 'border-[var(--color-line)] text-[var(--color-ink-dim)] hover:border-[var(--color-line-bright)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {m.org.name}
                    <span className="ml-2 text-[9px] uppercase tracking-[0.12em] opacity-60">
                      {m.role}
                    </span>
                  </Link>
                );
              })}
            </nav>
          ) : null}

          <div className="ml-auto flex items-center gap-5">
            {activeOrgId ? <QuotaMeter orgId={activeOrgId} /> : null}
            <div className="hidden text-right md:block">
              <Label>signed in</Label>
              <div className="max-w-[200px] truncate text-[12px] text-[var(--color-ink-dim)]">
                {email}
              </div>
            </div>
            <button
              onClick={signOut}
              className="border border-[var(--color-line-bright)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-dim)] transition-colors hover:border-[var(--color-fail)] hover:text-[var(--color-fail)]"
            >
              sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}
