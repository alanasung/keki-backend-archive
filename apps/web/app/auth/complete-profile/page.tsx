import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function CompleteProfilePage() {
  return (
    <PageShell
      title="Complete your profile"
      description="You're signed in, but no customer profile exists for this account yet."
    >
      <PlaceholderPanel title="Profile setup" plannedFor="Phase 2" />
    </PageShell>
  );
}
