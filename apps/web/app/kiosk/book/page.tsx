import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function KioskBookPage() {
  return (
    <PageShell
      title="Book"
      description="Self-serve booking for walk-in visitors, no account required."
    >
      <PlaceholderPanel title="Kiosk booking" plannedFor="Phase 2" />
    </PageShell>
  );
}
