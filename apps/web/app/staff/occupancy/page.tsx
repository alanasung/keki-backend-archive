import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function StaffOccupancyPage() {
  return (
    <PageShell title="Occupancy" description="See who is currently in the building.">
      <PlaceholderPanel title="Current occupancy" plannedFor="Phase 2" />
    </PageShell>
  );
}
