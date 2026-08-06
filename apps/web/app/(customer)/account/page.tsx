import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function AccountPage() {
  return (
    <PageShell
      title="Account"
      description="Manage your household and children, play passes, and waivers."
    >
      <PlaceholderPanel title="Account management" plannedFor="Phase 2" />
    </PageShell>
  );
}
