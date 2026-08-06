import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function AdminSchedulesPage() {
  return (
    <PageShell title="Schedules" description="Publish schedules of offering occurrences.">
      <PlaceholderPanel title="Schedules" plannedFor="Phase 2" />
    </PageShell>
  );
}
