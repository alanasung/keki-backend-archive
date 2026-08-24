import { PageShell } from '@keki/ui';
import { redirect } from 'next/navigation';
import { getSessionResult } from '../require-session';
import { ProfileForm } from './profile-form';

const SIGN_IN_PATH = '/auth/sign-in';
const AUTHENTICATED_REDIRECT_PATH = '/book';

// The one route that must handle the `unprovisioned` session case directly
// rather than delegating to the role guard in `../guards`: that guard
// redirects an unprovisioned session *here*, so using it on this page would
// loop forever.
export default async function CompleteProfilePage() {
  const result = await getSessionResult();

  if (result.kind === 'anonymous') {
    redirect(SIGN_IN_PATH);
  }
  if (result.kind === 'authenticated') {
    // A provisioned customer landing here has nothing to complete; showing
    // a form that would no-op is worse than moving them along.
    redirect(AUTHENTICATED_REDIRECT_PATH);
  }

  return (
    <PageShell
      title="Complete your profile"
      description="You're signed in, but no customer profile exists for this account yet."
    >
      <ProfileForm email={result.email} givenName={result.givenName} familyName={result.familyName} />
    </PageShell>
  );
}
