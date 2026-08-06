import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function AdminCustomersPage() {
  return (
    <PageShell title="Customers" description="Look up customers and their households.">
      <PlaceholderPanel title="Customer lookup" plannedFor="Phase 2" />
    </PageShell>
  );
}
