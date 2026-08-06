import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function StaffTodayPage() {
  return (
    <PageShell title="Today" description="Staff view of today's schedule.">
      <PlaceholderPanel title="Today's schedule" plannedFor="Phase 2" />
    </PageShell>
  );
}
