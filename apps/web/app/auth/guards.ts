import { authorize, type Session } from '@keki/auth';
import type { Role } from '@keki/contracts';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionResult } from './require-session';

const DEFAULT_NEXT_PATH = '/';

/**
 * Accepts only same-origin relative paths, so the `next` query parameter can
 * never bounce a signed-in user to an attacker-controlled host. Sign-in
 * pages are the classic open-redirect target: `//evil.example` parses as
 * protocol-relative, and a leading `/\` is normalized to `//` by some
 * browsers, so both are rejected alongside absolute URLs.
 */
export function sanitizeNextPath(candidate: string | null | undefined): string {
  if (candidate === null || candidate === undefined) {
    return DEFAULT_NEXT_PATH;
  }
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return DEFAULT_NEXT_PATH;
  }
  return candidate;
}

async function currentPath(): Promise<string> {
  const headerList = await headers();
  return headerList.get('x-pathname') ?? DEFAULT_NEXT_PATH;
}

/**
 * Enforces `requiredRole` on the calling layout, the real authorization
 * boundary for `staff/`, `admin/`, and `(customer)/`. Every allow/deny
 * decision is delegated to `authorize` from `@keki/auth`, which in turn
 * delegates role ordering to `hasAtLeastRole` — this function never compares
 * roles itself, so there is exactly one place that hierarchy can drift.
 *
 * The three denial reasons route to three distinct destinations. Collapsing
 * them would either loop a signed-in-but-unprovisioned user back through
 * sign-in, or hide an insufficient-role denial behind a generic sign-in
 * prompt.
 */
export async function requireRole(requiredRole: Role): Promise<Session> {
  const result = await getSessionResult();
  const outcome = authorize({ result, requiredRole });

  if (outcome.allowed) {
    return outcome.session;
  }

  if (outcome.reason === 'anonymous') {
    const next = sanitizeNextPath(await currentPath());
    redirect(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  }
  if (outcome.reason === 'unprovisioned') {
    redirect('/auth/complete-profile');
  }
  redirect('/auth/unauthorized');
}

const KIOSK_DEVICE_COOKIE_NAME = 'keki_kiosk_device';

// TODO(phase-2): a shared static device token is adequate for a Phase 1
// scaffold — it proves the "device session, not a user session" model end to
// end — but it is not a real device-identity mechanism. This needs a
// decision (per-device provisioning? hardware attestation?) before the
// kiosk surface handles waivers or payments.
/**
 * Enforces the kiosk's device-session model: shared on-site hardware
 * identified by a static token, per `docs/vision.md` assumption #3. This is
 * deliberately not `requireRole` — the kiosk never resolves a
 * `CustomerProfile` and never calls `authorize`, because there is no
 * customer identity to check yet, only a device.
 */
export async function requireKioskDevice(): Promise<void> {
  const cookieStore = await cookies();
  const deviceToken = cookieStore.get(KIOSK_DEVICE_COOKIE_NAME)?.value;
  const expectedToken = process.env.KIOSK_DEVICE_TOKEN;

  if (expectedToken === undefined || deviceToken === undefined || deviceToken !== expectedToken) {
    redirect('/auth/sign-in');
  }
}
