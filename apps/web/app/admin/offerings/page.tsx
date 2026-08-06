import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function AdminOfferingsPage() {
  return (
    <PageShell title="Offerings" description="Define classes, rooms, and open-play sessions.">
      <PlaceholderPanel title="Offerings" plannedFor="Phase 2" />
    </PageShell>
  );
}
