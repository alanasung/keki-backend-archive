import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function KioskWaiverPage() {
  return (
    <PageShell title="Waiver" description="Sign a liability waiver on-site before your visit.">
      <PlaceholderPanel title="Waiver signing" plannedFor="Phase 2" />
    </PageShell>
  );
}
