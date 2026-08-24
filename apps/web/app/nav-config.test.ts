import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { navConfig } from './nav-config';

const appDir = dirname(fileURLToPath(import.meta.url));

interface PageFile {
  readonly filePath: string;
  readonly urlPath: string;
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

function findPageFiles(dir: string, relSegments: readonly string[] = []): PageFile[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: PageFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      results.push(...findPageFiles(join(dir, entry.name), [...relSegments, entry.name]));
    } else if (entry.isFile() && entry.name === 'page.tsx') {
      const urlSegments = relSegments.filter((segment) => !isRouteGroup(segment));
      results.push({ filePath: join(dir, entry.name), urlPath: `/${urlSegments.join('/')}` });
    }
  }
  return results;
}

function findSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Demo-only routes, excluded from the product route brief and the
// placeholder assertions below. Both refuse to render unless their flag is
// set and NODE_ENV is not production:
//   /checkout/mock/*    stands in for Square's hosted payment page, so a
//                       local demo can complete a purchase without a public
//                       webhook endpoint.
//   /auth/demo-sign-in  installs a pre-minted token as a session, so the
//                       authorization gate can be demonstrated before
//                       Cognito's hosted sign-in flow exists.
const DEMO_ONLY_ROUTE_PREFIXES = ['/checkout/mock', '/auth/demo-sign-in'];

const pageFiles = findPageFiles(appDir).filter(
  (page) => !DEMO_ONLY_ROUTE_PREFIXES.some((prefix) => page.urlPath.startsWith(prefix)),
);
// `/auth/*` pages (WS-09) are utility routes for the authorization boundary,
// not tied to any of the four nav surfaces in `navConfig` — they're asserted
// separately below rather than folded into the nav-surface route brief.
// `/book` (WS-08), `/cart` (WS-09's cart/participants workstream), and
// `/orders/[orderId]` (WS-13's status page) are the surfaces built out past
// the placeholder stage, so each is asserted on its own rather than folded
// into the placeholder brief.
const placeholderPageFiles = pageFiles.filter(
  (page) =>
    page.urlPath !== '/' &&
    page.urlPath !== '/book' &&
    page.urlPath !== '/cart' &&
    page.urlPath !== '/orders/[orderId]' &&
    // `/account` reads the household, its members, and the order history —
    // all through queries that already existed. Editing a household, passes,
    // and waivers stay unbuilt and are labelled as such on the page itself.
    page.urlPath !== '/account' &&
    // `/admin/offerings` (WS-06) lists, creates, edits, publishes, and
    // archives offerings — built out past the placeholder stage, same as
    // `/book` and `/account` above.
    page.urlPath !== '/admin/offerings' &&
    // `/admin/schedules` (WS-07) lists upcoming occurrences, schedules new
    // ones, and edits/cancels existing ones — built out past the
    // placeholder stage, same as `/admin/offerings` above.
    page.urlPath !== '/admin/schedules' &&
    // `/admin/reservations` (WS-08) is a read-only roster of who is booked
    // on an occurrence — built out past the placeholder stage, same as
    // `/admin/schedules` above.
    page.urlPath !== '/admin/reservations' &&
    // `/staff/today` (WS-06) lists today's occurrences with expected and
    // arrived counts — built out past the placeholder stage, same as the
    // admin surfaces above.
    page.urlPath !== '/staff/today' &&
    // `/staff/check-in` (WS-07) lists an occurrence's participants with
    // per-row check-in, undo, and no-show controls — built out past the
    // placeholder stage, same as `/staff/today` above.
    page.urlPath !== '/staff/check-in' &&
    // `/staff/occupancy` (WS-08) reports the current in-building headcount
    // via `getCurrentOccupancy` — built out past the placeholder stage,
    // same as `/staff/check-in` above.
    page.urlPath !== '/staff/occupancy' &&
    !page.urlPath.startsWith('/auth/'),
);
const authPageFiles = pageFiles.filter(
  (page) =>
    page.urlPath.startsWith('/auth/') &&
    // `/auth/complete-profile` (WS-05) is the first-time profile-provisioning
    // form, built out past the placeholder stage the same as `/book` and
    // `/account` above — asserted with the other non-placeholder surfaces
    // rather than here.
    page.urlPath !== '/auth/complete-profile',
);
const surfaces = Object.keys(navConfig) as Array<keyof typeof navConfig>;

describe('nav-config', () => {
  it('every surface has a non-empty nav item list', () => {
    for (const surface of surfaces) {
      expect(navConfig[surface].length).toBeGreaterThan(0);
    }
  });

  it('every nav href resolves to a real route file', () => {
    const knownUrlPaths = new Set(pageFiles.map((page) => page.urlPath));
    for (const surface of surfaces) {
      for (const item of navConfig[surface]) {
        expect(knownUrlPaths.has(item.href)).toBe(true);
      }
    }
  });

  it('customer routes omit the group name', () => {
    for (const item of navConfig.customer) {
      expect(item.href.startsWith('/(customer)')).toBe(false);
      expect(item.href.startsWith('/customer')).toBe(false);
    }
  });

  it('nav hrefs are unique within a surface', () => {
    for (const surface of surfaces) {
      const hrefs = navConfig[surface].map((item) => item.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });

  it('the route tree matches the brief', () => {
    // `/account` is deliberately absent: it was built out into a read-only
    // household, order-history, passes, and waivers view, so it is asserted
    // with the other non-placeholder surfaces rather than here.
    const expectedUrlPaths = new Set(['/kiosk/book', '/kiosk/waiver', '/admin/customers']);
    expect(placeholderPageFiles).toHaveLength(3);
    expect(new Set(placeholderPageFiles.map((page) => page.urlPath))).toEqual(expectedUrlPaths);
  });

  it('the auth surface matches its remaining placeholder pages', () => {
    // `/auth/sign-in` was WS-09's placeholder; WS-04 replaced it with a Route
    // Handler (`route.ts`), since a Server Component cannot write the state
    // and verifier cookies the redirect handshake needs. It no longer has a
    // `page.tsx` and so no longer counts here.
    // `/auth/complete-profile` was built out by WS-05 and is excluded from
    // `authPageFiles` above.
    const expectedAuthUrlPaths = new Set(['/auth/unauthorized']);
    expect(authPageFiles).toHaveLength(1);
    expect(new Set(authPageFiles.map((page) => page.urlPath))).toEqual(expectedAuthUrlPaths);
  });

  it('every placeholder page renders a PlaceholderPanel', () => {
    for (const page of [...placeholderPageFiles, ...authPageFiles]) {
      const source = readFileSync(page.filePath, 'utf-8');
      expect(source).toMatch(/import\s*\{[^}]*\bPlaceholderPanel\b[^}]*\}\s*from\s*['"]@keki\/ui['"]/);
      expect(source).toMatch(/<PlaceholderPanel\b/);
    }
  });

  it('no page performs data access', () => {
    // `app/actions/**`, `(customer)/book/**`, and `(customer)/cart/**` are
    // exempt: per AGENTS.md ("Data access"), domain packages are imported
    // directly by Server Actions and by the read-only Server Components that
    // render them, with no internal HTTP hop between the app and the core.
    // WS-07 establishes the actions module as one sanctioned boundary; WS-08
    // establishes the ordering page's Server Components (`listCafeItems`,
    // `listBookableOfferings`) as another; WS-09 adds the cart module
    // (its own Server Actions, cookie codec, and the review page's
    // server-side price resolution) as a third; WS-13 adds the composition
    // root and the order status page as a fourth. Every other page stays a
    // placeholder.
    // `(customer)/checkout/mock/**` is the demo-only stand-in for Square's
    // hosted payment page. It reads the order and drives the same two
    // transitions the webhook consumer performs, so it is a sanctioned
    // boundary on the same terms as the others — and it refuses to render
    // outside a flagged, non-production environment.
    const exemptPrefixes = [
      `actions${sep}`,
      // WS-05's admin Server Actions: the same sanctioned data-access
      // boundary as the top-level `actions/` module, established for the
      // admin surface. WS-06 through WS-08 exempt the admin pages
      // themselves as each is built — this covers only the actions module.
      `admin${sep}actions${sep}`,
      // The offerings page (WS-06): a Server Component listing every
      // offering via `listOfferings`, plus the two client islands
      // (offering-form.tsx, offering-row.tsx) that call WS-05's admin
      // Server Actions — the same sanctioned boundary as the account page.
      `admin${sep}offerings${sep}`,
      // The schedules page (WS-07): a Server Component listing upcoming
      // occurrences via `listUpcomingOccurrences` and offerings via
      // `listOfferings`, plus the two client islands (schedule-form.tsx,
      // occurrence-row.tsx) that call WS-05's admin Server Actions — the
      // same sanctioned boundary as the offerings page.
      `admin${sep}schedules${sep}`,
      // The reservations page (WS-08): a read-only Server Component listing
      // upcoming occurrences via `listUpcomingOccurrences`, that occurrence's
      // reservations via `listReservationsForOccurrence`, and resolving
      // participant names via `listParticipantsForReservation`,
      // `getCustomerById`, and `listHouseholdMembers` — the same sanctioned
      // boundary as the offerings and schedules pages, with no Server
      // Actions since this surface performs no mutation.
      `admin${sep}reservations${sep}`,
      // WS-05's staff Server Actions: the same sanctioned data-access
      // boundary as the top-level `actions/` and `admin/actions/` modules,
      // established for the staff surface. WS-06 through WS-08 exempt the
      // staff pages themselves as each is built — this covers only the
      // actions module.
      `staff${sep}actions${sep}`,
      // The today page (WS-06): a read-only Server Component listing today's
      // occurrences via `listTodaysOccurrences` — the same sanctioned
      // boundary as the admin pages above, with no Server Actions since this
      // surface performs no mutation.
      `staff${sep}today${sep}`,
      // The check-in page (WS-07): a Server Component listing an
      // occurrence's roster via `listTodaysOccurrences` and
      // `listOccurrenceRoster`, plus the client island (roster-row.tsx) that
      // calls WS-05's staff Server Actions — the same sanctioned boundary as
      // the offerings and schedules pages.
      `staff${sep}check-in${sep}`,
      // The occupancy page (WS-08): a read-only Server Component reporting
      // the current in-building headcount via `getCurrentOccupancy` — the
      // same sanctioned boundary as the today and check-in pages, with no
      // Server Actions since this surface performs no mutation.
      `staff${sep}occupancy${sep}`,
      `(customer)${sep}book${sep}`,
      `(customer)${sep}cart${sep}`,
      `(customer)${sep}orders${sep}`,
      `(customer)${sep}checkout${sep}mock${sep}`,
      // The account page is a read-only Server Component over
      // customer-core's household queries and commerce-core's order history
      // — the same sanctioned boundary as the ordering page.
      `(customer)${sep}account${sep}`,
      // The complete-profile page (WS-05): its Server Action calls
      // customer-core's `provisionCustomerProfile` directly, the same
      // sanctioned boundary as the top-level `actions/` module — this is the
      // one mutation that must run before a profile exists, so it cannot go
      // through that module's `authenticatedAction` wrapper.
      `auth${sep}complete-profile${sep}`,
      'server-clients',
    ];
    const sourceFiles = findSourceFiles(appDir).filter(
      (filePath) =>
        !filePath.endsWith('.test.ts') &&
        !filePath.endsWith('.test.tsx') &&
        !exemptPrefixes.some((prefix) => relative(appDir, filePath).startsWith(prefix)),
    );
    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, 'utf-8');
      expect(source).not.toMatch(/@keki\/database/);
      expect(source).not.toMatch(/@keki\/[\w-]*-core/);
    }
  });

  it('transpilePackages includes the source-export packages', () => {
    expect(nextConfig.transpilePackages).toContain('@keki/ui');
    expect(nextConfig.transpilePackages).toContain('@keki/contracts');
    expect(nextConfig.typedRoutes).toBe(true);
  });
});
