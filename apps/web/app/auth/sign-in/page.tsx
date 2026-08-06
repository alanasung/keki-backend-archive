import { PageShell, PlaceholderPanel } from '@keki/ui';
import { sanitizeNextPath } from '../guards';

interface SignInPageProps {
  readonly searchParams: Promise<{ readonly next?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const next = sanitizeNextPath(params.next);

  return (
    <PageShell
      title="Sign in"
      description="Cognito owns authentication. The hosted sign-in flow arrives in Phase 2 — this placeholder only preserves where to return afterward."
    >
      <PlaceholderPanel title={`Will continue to ${next} after sign-in`} plannedFor="Phase 2" />
    </PageShell>
  );
}
