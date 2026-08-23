# WS-08: `/admin/customers` — staff customer lookup

## Goal

Replace the `/admin/customers` placeholder with the surface staff reach for when
someone phones: find a household by email or name, then see who is in it, which
children belong to it, and what they have ordered.

This is the last admin placeholder. Phase 3 built offerings, schedules, and
reservations and left this one explicitly out of scope. The question it answers
— *"a customer is on the phone, what do I know about them"* — currently requires
a SQL query.

Read-only. Staff editing a household is a larger second question this program
does not open.

## Traceability

- **SC-16** — `/admin/customers` finds a household by customer email or name
  and shows its members, children, and recent orders.

## Dependencies

- **WS-01** — Contracts (the search input schema).

> Deliberately **not** dependent on WS-06: this is a read-only surface over
> data that already exists, so it can be built as soon as the schemas land and
> carries real slack against the auth chain.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; every `admin/` route requires an explicit role check
- `docs/vision.md` — "Target Users"; the Manager/Admin persona
- `apps/web/app/admin/customers/page.tsx` — the placeholder being replaced
- `apps/web/app/admin/layout.tsx` — the existing `requireRole('MANAGER')`
- `apps/web/app/admin/reservations/page.tsx` — Phase 3's read-only admin
  surface, including its `searchParams` selection pattern
- `apps/web/app/admin/reservations/occurrence-roster.tsx` — how participant
  names are resolved, and its `'Unknown participant'` and no-participants
  fallbacks
- `packages/customer-core/src/queries.ts` — `getCustomerById`,
  `getHouseholdById`, `listHouseholdMembers`
- `packages/commerce-core/src/queries.ts` — `listOrdersForHousehold`
- `packages/database/src/schema/people.ts` — `customers.email` is `citext unique`
- `packages/ui/src/components/empty-state.tsx` — the empty state
- `apps/web/app/nav-config.test.ts` — the placeholder brief and allowlist

## Package

`apps/web`, plus a query addition in `packages/customer-core`

## Files Touched

- `apps/web/app/admin/customers/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/admin/customers/customer-search.tsx` (NEW)
- `apps/web/app/admin/customers/household-detail.tsx` (NEW)
- `apps/web/app/admin/customers/page.test.tsx` (NEW)
- `packages/customer-core/src/queries.ts` (MODIFY — add the search query)
- `packages/customer-core/src/search.integration.test.ts` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — customers is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced, in full:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function AdminCustomersPage() {
  return (
    <PageShell title="Customers" description="Look up households and their members.">
      <PlaceholderPanel title="Customer lookup" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

The reads this composes:

```ts
export async function getHouseholdById(id: HouseholdId): Promise<Household | null>;

export async function listHouseholdMembers(
  householdId: HouseholdId,
): Promise<{ customers: readonly Customer[]; children: readonly Child[] }>;
```

The route-level guard already in place — this page adds no guard of its own:

```ts
export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  await requireRole('MANAGER');
  ...
```

The column that makes email search behave: `customers.email` is `citext`, so
comparison is already case-insensitive at the database and the query must not
re-lower it and defeat the index.

```ts
email: citext('email').unique(),
```

Phase 3's linkable-selection pattern, which this mirrors so a staff member can
send a household to a colleague:

```tsx
// Take the occurrence from a `searchParams` value rather than component
// state, so a roster is linkable — staff will want to send one to a
// colleague, and a client-state selection cannot be shared.
```

## Implementation Steps

1. **Add the search query** to `packages/customer-core/src/queries.ts`:

   ```ts
   export interface CustomerSearchResult {
     readonly customerId: CustomerId;
     readonly householdId: HouseholdId;
     readonly firstName: string;
     readonly lastName: string;
     readonly email: string;
   }

   export async function searchCustomers(input: {
     query: string;
     limit?: number;
   }): Promise<readonly CustomerSearchResult[]>;
   ```

   Match on email or on first/last name, case-insensitively, with a default
   limit of 25.

   **Do not lower-case the email side of the comparison.** `citext` already
   compares case-insensitively, and wrapping the column in `lower()` discards
   the unique index and turns every lookup into a sequential scan.

   Require at least two characters; a one-character query returns most of the
   table and is never what someone meant.

2. **Build the page** in `page.tsx` as a Server Component. Take both the search
   term and the selected household from `searchParams`, so a result — and a
   household — is linkable. Phase 3 established that pattern for exactly this
   reason.

   Add no role guard: `admin/layout.tsx` already enforces `MANAGER`, and a
   second one here would drift from it.

3. **Build the search form** in `customer-search.tsx`. A plain form submitting
   a GET to the same page — no client island, no action. The result is a URL,
   which is the point.

4. **Build the household detail** in `household-detail.tsx`: the household
   name, its adult members with emails, its children with dates of birth, and
   recent orders with status and total.

   Show **children's dates of birth, not computed ages.** An age is a
   derivation that is wrong for one day a year and invites the reader to
   recompute it; staff checking whether a child fits a class want the date.

5. **Handle every empty state distinctly.** Four exist here and collapsing them
   is how the page becomes confusing:

   - No search yet → invite one
   - A search with no matches → say so, with the term
   - A household with no children → say so plainly
   - A household with no orders → say so

   Phase 3 shipped a roster that rendered eleven blank rows because
   `[].join(', ')` is the empty string. Do not repeat it: never render a row
   whose content resolves to nothing.

6. **Do not add any mutation.** No editing a household, no adding a child on a
   customer's behalf, no resetting anything. Read-only is the scope, and every
   one of those raises a question — consent, audit, impersonation — this
   program does not answer.

7. **Update `nav-config.test.ts`**: remove `/admin/customers` from the
   placeholder brief and add `admin${sep}customers${sep}` to the data-access
   allowlist.

8. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest and the queries mocked at the module boundary;
`searchCustomers` gets integration coverage under a suite named
`integration: customer-core search`, isolated by per-test `crypto.randomUUID()`.

1. **`searchCustomers` finds by exact email** _(integration)_ — Assert the
   seeded customer is returned. **This is SC-16's core.**
2. **Email search is case-insensitive** _(integration)_ — Seed
   `Ada@Example.test`, search `ada@example.test`; assert a match. `citext`
   should make this free — the test proves the query did not defeat it.
3. **It finds by partial last name** _(integration)_ — Seed `Lovelace`, search
   `love`; assert a match.
4. **It finds by partial first name** _(integration)_ — Assert the same.
5. **A non-matching term returns an empty array** _(integration)_ — Assert
   `[]`, not null and not an error.
6. **A one-character query is refused** _(integration)_ — Assert it throws or
   returns empty rather than most of the table.
7. **The limit is respected** _(integration)_ — Seed 30 matching customers with
   a limit of 25; assert exactly 25 come back.
8. **Results carry the household id** _(integration)_ — Assert it is present,
   since selecting a result is how the detail view is reached.
9. **The query does not lower-case the email column** — Assert the generated
   SQL contains no `lower(` applied to `email`, which would discard the unique
   index.
10. **The page renders a search form** — Assert the input and submit exist.
11. **Submitting search puts the term in the URL** — Assert the form is a GET
    to the same route, so a result is linkable.
12. **Search results render name and email** — Mock two; assert both appear.
13. **A search with no matches says so, naming the term** — Assert the term
    appears in the message, so a staff member sees what was actually searched.
14. **No search yet renders an invitation, not an error** — Assert the initial
    state reads as a prompt.
15. **Selecting a household renders its members** — Assert adult names and
    emails appear.
16. **It renders children with dates of birth** — Assert a date appears, not a
    computed age.
17. **A household with no children says so** — Assert the message rather than
    an empty list.
18. **It renders recent orders with status and total** — Mock two; assert both
    statuses and formatted totals.
19. **A household with no orders says so** — Assert the message.
20. **No row renders as blank** — Mock a customer with an empty last name;
    assert the row still shows something identifying rather than an empty line.
    Phase 3 shipped eleven blank rows; this is the regression guard.
21. **An unknown household id renders not-found rather than crashing** — Assert
    a graceful result.
22. **The selected household comes from `searchParams`** — Assert a given id
    renders that household, so the view is linkable.
23. **No mutation control is rendered** — Assert there is no edit, add-child,
    or delete control anywhere on the page.
24. **The page adds no role guard of its own** — Assert it does not call
    `requireRole`; the layout owns that and two checks would drift.
25. **`nav-config.test.ts` no longer treats `/admin/customers` as a
    placeholder** — Assert the brief no longer lists it.

## Acceptance Criteria

1. `apps/web` and `packages/customer-core` pass all four scripts, and
   `pnpm -r typecheck` and `pnpm test` pass workspace-wide.
2. `searchCustomers` finds by email and by partial first or last name,
   case-insensitively (tests 1–4). **SC-16.**
3. Email comparison relies on `citext` rather than `lower()`, preserving the
   unique index (tests 2, 9).
4. A short query is refused and a non-matching one returns an empty array
   (tests 5–6).
5. The result limit is honoured (test 7).
6. Search and household selection are both driven by `searchParams`, making
   results linkable (tests 11, 22).
7. A selected household shows members, children with dates of birth, and recent
   orders (tests 15–16, 18). **SC-16.**
8. All four empty states render distinctly, and **no row ever renders blank**
   (tests 13–14, 17, 19–20).
9. An unknown household id renders gracefully (test 21).
10. No mutation control of any kind is added (test 23).
11. The page relies on the layout's `requireRole('MANAGER')` and adds no second
    guard (test 24).
12. `nav-config.test.ts` no longer treats `/admin/customers` as a placeholder
    (test 25).
