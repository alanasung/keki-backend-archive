import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function AdminReservationsPage() {
  return (
    <PageShell title="Reservations" description="Resolve and manage customer reservations.">
      <PlaceholderPanel title="Reservations" plannedFor="Phase 2" />
    </PageShell>
  );
}
