import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function UnauthorizedPage() {
  return (
    <PageShell
      title="Not authorized"
      description="Your account does not have the role required for that page."
    >
      <PlaceholderPanel title="Access denied" plannedFor="Phase 2" />
    </PageShell>
  );
}
