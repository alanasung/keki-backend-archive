import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function StaffCheckInPage() {
  return (
    <PageShell title="Check-in" description="Check visitors in for their reservations.">
      <PlaceholderPanel title="Check-in" plannedFor="Phase 2" />
    </PageShell>
  );
}
