import { notFound } from 'next/navigation';
import { PageShell } from '@keki/ui';
import type { Role } from '@keki/contracts';
import { availableDemoRoles, isDemoSignInEnabled } from './demo-config';
import { demoSignInAction, demoSignOutAction } from './sign-in-action';

// Reads env and the current cookie, so it must never be cached.
export const dynamic = 'force-dynamic';

const ROLE_BLURB: Record<Role, string> = {
  CUSTOMER: 'Browse the menu, book a class seat, and check out.',
  FRONT_OF_HOUSE: 'Staff surfaces: today’s schedule, check-in, occupancy.',
  MANAGER: 'Everything front of house can reach, plus the admin surfaces.',
  ADMIN: 'Full access, including customer records.',
};

interface DemoSignInPageProps {
  readonly searchParams: Promise<{ readonly next?: string }>;
}

export default async function DemoSignInPage({ searchParams }: DemoSignInPageProps) {
  // The route should not exist outside a flagged, non-production demo — 404
  // rather than render a disabled page, so its absence is unambiguous.
  if (!isDemoSignInEnabled()) {
    notFound();
  }

  const params = await searchParams;
  const next = params.next ?? '/book';
  const roles = availableDemoRoles();

  return (
    <PageShell
      title="Demo sign-in"
      description="Pick a seeded user to sign in as. Real Cognito sign-in arrives with the hosted flow."
    >
      <div className="flex max-w-xl flex-col gap-5">
        <p className="rounded-lg border border-brand-300 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          <strong>Demo only.</strong> These are seeded test users, and the tokens are signed by the
          local demo issuer. The authorization gate itself is unchanged — every token is verified
          exactly as a real one would be.
        </p>

        {roles.length === 0 ? (
          <p className="text-sm text-surface-600">
            No demo tokens were provided. Start the app with <code>pnpm demo:serve</code>, which
            mints one per role.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {roles.map((role) => (
              <li key={role}>
                <form action={demoSignInAction}>
                  <input type="hidden" name="role" value={role} />
                  <input type="hidden" name="next" value={next} />
                  <button
                    type="submit"
                    className="flex w-full flex-col gap-1 rounded-xl border border-surface-200 bg-white p-4 text-left transition hover:border-brand-500 hover:bg-brand-50"
                  >
                    <span className="text-sm font-semibold text-surface-900">
                      {role.replaceAll('_', ' ')}
                    </span>
                    <span className="text-sm text-surface-600">{ROLE_BLURB[role]}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form action={demoSignOutAction}>
          <button type="submit" className="text-sm text-surface-600 underline hover:text-surface-900">
            Sign out
          </button>
        </form>
      </div>
    </PageShell>
  );
}
