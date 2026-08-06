import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function BookPage() {
  return (
    <PageShell title="Book" description="Browse and book classes, rooms, and open-play sessions.">
      <PlaceholderPanel title="Booking" plannedFor="Phase 2" />
    </PageShell>
  );
}
