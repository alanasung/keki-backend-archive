# keki-backend-prod — Program Plan (Phase 3 Admin Catalog)

> **Note on `docs/as-built.md`.** That snapshot is stale: it was last written
> after `phase-1-scaffold` and still describes every domain command as a stub
> and every page as a placeholder. `phase-2-square-ordering` has since shipped
> and is green in CI. This plan is written against the code as it actually
> stands; running `/update-as-built` before the next program would remove the
> discrepancy.

## Program Overview

**Product:** Keki is the commerce and operations platform for a cafe that runs
classes, rents rooms, and hosts open play. One Next.js 15 application on AWS
serves four surfaces — customer, kiosk, staff, admin — over a set of plain
TypeScript domain packages, with Square for payments, a waiver provider for
liability signing, and Klaviyo/SES/SMS for customer communication.

**Program scope:** Give staff a way to create the things customers buy. Phase 2
built a working ordering system — catalog, cart, participants, checkout,
capacity, fulfillment — on top of offerings and occurrences that **no one can
create**. They exist today only because a seed script inserts them. This
program builds the admin surface that manages them: draft an offering, publish
it, schedule dated occurrences, and see what has been booked.

It is also the first program to write `staff_audit_log`, a table that has
existed since Phase 1 and has never had a single row.

## Strategic Goals

1. **Remove engineering from the path to a sellable class.** A manager should
   create and publish a class without a script, a migration, or a developer.
2. **Make the supply side visible.** Staff can see what is scheduled, how full
   it is, and what changed — the questions asked before a class runs.
3. **Write the audit trail that already has a table.** Every catalog mutation
   records who did what, so a price or capacity change is attributable.
4. **Keep the customer surface honest under edits.** Publishing, unpublishing,
   and capacity changes must land safely while people are mid-checkout.
5. **Establish the admin mutation pattern once**, the way WS-07 established the
   customer one — so staff and kiosk surfaces copy it rather than inventing it.

## Architecture Changes

Changes from the system as it actually stands after `phase-2-square-ordering`.

**One new package: `packages/catalog-admin`.** `catalog-core` is deliberately
read-only — it serves the customer ordering page and the scheduled sync. Write
paths for offerings and occurrences do not belong there: a customer-facing
query package should not carry the ability to publish or archive. The new
package depends on `contracts` and `database` only, matching every other core.

**`staff_audit_log` gets its first writer.** Every catalog mutation writes one
row inside the same transaction as the change itself. Not a side effect
afterward — an audit entry that can be lost when the write succeeds is worse
than none, because it implies completeness it does not have.

**Offering status becomes a real state machine.** `DRAFT → PUBLISHED →
ARCHIVED` already exists as an enum; nothing enforces the transitions. This
program adds a transition table in `contracts` and a guarded transition
command, mirroring `ORDER_TRANSITIONS` from Phase 2.

**Slugs are generated, not typed.** `offerings.slug` is unique and load-bearing
for future public URLs. Staff should not hand-author them and discover a
collision at insert time; the command derives a slug from the name and
disambiguates.

**Capacity edits are permitted and surfaced, not blocked.** Lowering
`default_capacity` or `capacity_override` below what is already booked is
allowed. `seatsRemaining` already clamps at zero and the page already renders
"sold out", so the customer surface is safe; the admin surface warns and names
the count. The constraint is physical — a room got smaller — and refusing the
edit would leave staff with no way to record reality.

**Occurrence cancellation is restricted to unbooked occurrences.** Refunds do
not exist: `PAID` is terminal in the order state machine and `refundPayment` is
still a stub. Cancelling a class people paid for would leave money owed with no
tracked path, so this program refuses it rather than pretending.

**Server Actions gain a `MANAGER` boundary.** WS-07's `authenticatedAction`
already accepts a `requiredRole`; the admin actions pass `MANAGER`, and the
existing `/admin` layout guard stays as the route-level check. Two independent
enforcement points, which is what makes a missed one survivable.

## Technology Choices

No new technology — uses the existing stack. Four decisions this program
settles that the brief left open:

| Decision | Choice | Rationale |
| --- | --- | --- |
| Recurring schedules | Not in this program; one occurrence at a time | Recurrence needs a series concept, plus rules for editing and cancelling single instances. It can be added later without redoing this work; shipping without it gets staff unblocked sooner. |
| Capacity below bookings | Allowed, with a warning naming the booked count | The database already handles over-subscription safely. Refusing leaves staff unable to record a real-world change. |
| Cancelling booked occurrences | Refused while refunds are unbuilt | Avoids taking a dependency on `refundPayment`, and avoids leaving customers owed money with no record. |
| Offering types | `CLASS` only | Rooms and open play are not bookable on the customer surface, so creating them would produce offerings with no path to purchase. |

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
| --- | --- | --- | --- |
| WS-01 | Contracts: offering status transitions, admin input schemas, audit types | — | S |
| WS-02 | `catalog-admin`: offering create, edit, and guarded status transitions | WS-01 | M |
| WS-03 | `catalog-admin`: occurrence scheduling, edit, and cancellation | WS-01, WS-02 | M |
| WS-04 | Audit logging: transactional `staff_audit_log` writes for every mutation | WS-01, WS-02 | S |
| WS-05 | Admin Server Actions with the `MANAGER` boundary | WS-02, WS-03 | S |
| WS-06 | `/admin/offerings`: list, create, edit, publish, archive | WS-05 | M |
| WS-07 | `/admin/schedules`: occurrence calendar, scheduling, cancellation | WS-05 | M |
| WS-08 | `/admin/reservations`: who booked what, per occurrence | WS-03 | M |
| WS-09 | Tests, e2e coverage, and documentation | WS-06, WS-07, WS-08 | M |

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

### Workstream detail

- **WS-01** — `OFFERING_TRANSITIONS` plus `canTransitionOffering`, mirroring
  WS-01 of Phase 2's order machine. Zod schemas for offering and occurrence
  input, deliberately excluding `slug` (derived) and `status` (transitioned,
  never set directly). `AuditAction` constants and the audit entry type.
- **WS-02** — `createOffering` (deriving a unique slug), `updateOffering`, and
  `transitionOffering` for publish/archive. Guards the transition table and
  rejects a `type` other than `CLASS`. Money stays in integer cents.
- **WS-03** — `scheduleOccurrence` (computing `ends_at` from the offering's
  `duration_minutes`), `updateOccurrence`, and `cancelOccurrence`, which
  refuses when confirmed reservations exist. Rejects scheduling in the past
  and overlapping occurrences of the same offering.
- **WS-04** — `recordAuditEntry`, called inside each mutation's transaction so
  the entry and the change commit together. Captures actor, action, entity,
  and a before/after diff.
- **WS-05** — Admin actions through `authenticatedAction({ requiredRole:
  'MANAGER' })`, reusing WS-07's envelope and error mapping from Phase 2. Adds
  admin-specific error mappings.
- **WS-06** — The offerings surface: list with status, create and edit forms,
  publish and archive controls. Publishing is what makes a class sellable, so
  the page states plainly what publishing does.
- **WS-07** — The schedules surface: upcoming occurrences grouped by day with
  seats booked, a scheduling form, and cancellation limited to unbooked
  occurrences with the reason shown when refused.
- **WS-08** — The reservations surface: per occurrence, who is booked, with
  participant names and reservation status. Read-only; check-in belongs to the
  staff surface.
- **WS-09** — Unit coverage for the transition and slug logic, integration
  coverage for the audit-in-transaction guarantee and the cancellation refusal,
  a Playwright journey creating and publishing a class that then appears on
  `/book`, and documentation.

## Dependency Graph

```
                     WS-01 (contracts)
                    /        |        \
                   /         |         \
        WS-02 (offerings)    |          \
           /      |     \    |           \
          /       |      \   |            \
   WS-04 (audit)  |   WS-03 (occurrences)  |
          \       |      /        \        |
           \      |     /          \       |
            WS-05 (admin actions)   WS-08 (reservations)
              /            \                |
     WS-06 (offerings UI)  WS-07 (schedules UI)
              \             |               |
               +------------+---------------+
                            |
                     WS-09 (tests + docs)

WS-03 depends on WS-01 and WS-02 — an occurrence needs its offering's duration.
WS-04 depends on WS-01 and WS-02 — it wraps the mutations WS-02 introduces.
WS-05 depends on WS-02 and WS-03.
WS-08 depends on WS-03.
WS-09 depends on WS-06, WS-07, and WS-08.
```

Parallelism: WS-02 and WS-03 are sequential (occurrences need offerings), but
WS-04 runs alongside WS-03, and WS-06/WS-07/WS-08 fan out from WS-05.

## Critical Path

```
WS-01 → WS-02 → WS-03 → WS-05 → WS-06 → WS-09
```

Roughly 19 working days serialized — a smaller program than Phase 2's 35, and
deliberately so. It adds no third-party integration, no new infrastructure, and
no money movement. The risk profile is ordinary CRUD over a schema that already
exists and is already exercised by a working customer surface.

The path runs through occurrence scheduling, because that is what makes a class
actually appear on `/book`. WS-06 and WS-07 are the same size and tie for the
last leg — whichever is scheduled second is on the path — so neither carries
real slack against the other. WS-08 does.

The one place to be careful is WS-03. Scheduling looks like a simple insert and
is not: it computes `ends_at` from the offering, refuses past dates, and has to
interact correctly with the capacity trigger and with reservations that may
already exist against an occurrence being edited.

## Scope (In)

- `packages/catalog-admin` with offering and occurrence write paths
- Offering create, edit, publish, archive, guarded by a status transition table
- Generated unique slugs
- Occurrence scheduling with `ends_at` derived from the offering
- Occurrence edit, including capacity override
- Occurrence cancellation, restricted to unbooked occurrences
- Capacity edits below current bookings, permitted with a warning
- `staff_audit_log` writes inside each mutation's transaction
- Admin Server Actions gated on `MANAGER`
- `/admin/offerings`, `/admin/schedules`, `/admin/reservations`
- Unit, integration, and Playwright coverage; documentation

## Scope (Out)

Explicitly deferred — do not implement in this program:

- Recurring schedules or a series concept
- Cancelling occurrences that have confirmed reservations
- Refunds, and any dependency on `refundPayment`
- `ROOM` and `OPEN_PLAY` offerings
- Deleting offerings or occurrences — archive and cancel are the exits
- Editing or moving an existing reservation, and check-in
- `/admin/customers`, which stays a placeholder
- Staff surfaces: `/staff/today`, `/staff/check-in`, `/staff/occupancy`
- Play passes and waivers
- Image or media upload for offerings
- Bulk import of a schedule
- An audit-log viewer — this program writes entries, it does not display them

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| An audit entry is written outside the mutation's transaction | High — a log that silently misses entries is worse than none, because it implies a completeness it lacks | `recordAuditEntry` takes the transaction handle and is called within it, following the `SeatHolder` precedent. A WS-04 test rolls a mutation back and asserts no orphan entry survives. |
| Capacity lowered below bookings breaks the customer page | Medium — a negative seat count or a crash on `/book` | Already handled: `seatsRemaining` clamps at zero and renders "sold out". A WS-03 test lowers capacity under load and asserts the customer query still returns zero, not negative. |
| Unpublishing an offering mid-checkout | Medium — a customer holding a seat for something no longer sellable | `createOrder` already re-validates that the offering is published, so checkout fails cleanly rather than selling an unpublished class. A WS-02 test asserts that path. |
| Slug collision on similar names | Low — an insert failure staff cannot interpret | Slugs are derived and disambiguated by the command, never typed. A WS-02 test creates two offerings with the same name. |
| Scheduling an occurrence in the past | Medium — invisible on `/book`, which filters to future occurrences, so staff think it failed | Refused at the command with a clear message rather than silently accepted. |
| Overlapping occurrences of the same offering | Medium — double-booked room, and ambiguous seat counts | Refused at the command. Deliberately not a database constraint: two *different* offerings may legitimately overlap, so the rule is per offering. |
| Admin actions reachable without MANAGER | **Critical** — anyone signed in could publish or reprice | Two independent checks: the existing `/admin` layout guard, and `requiredRole: 'MANAGER'` on every action. A WS-05 test calls each action as a CUSTOMER. |
| Money handled as anything but integer cents | High — rounding errors in prices | `price_cents` stays an integer everywhere; the form parses to cents at the edge. Mirrors the Phase 2 rule. |
| `docs/as-built.md` misleads the build agents | Medium — specs written against a Phase 1 view of the system | Named at the top of this document. `/update-as-built` should run before WS-01. |

## Success Criteria

| ID | Outcome |
| --- | --- |
| SC-01 | A manager can create a `CLASS` offering with a name, description, duration, capacity, and price, and it is saved as `DRAFT`. |
| SC-02 | Offering slugs are generated from the name and stay unique when two offerings share a name. |
| SC-03 | Publishing moves an offering `DRAFT → PUBLISHED`; archiving moves it to `ARCHIVED`; an undeclared transition is refused. |
| SC-04 | A manager can schedule an occurrence for a published offering, and `ends_at` is derived from the offering's duration. |
| SC-05 | Scheduling an occurrence in the past is refused with a clear message. |
| SC-06 | Two overlapping occurrences of the same offering are refused. |
| SC-07 | A scheduled occurrence of a published offering appears on `/book` with its seat count. |
| SC-08 | Lowering capacity below the booked count succeeds, warns the manager with the booked count, and leaves `/book` showing zero seats rather than a negative number. |
| SC-09 | Cancelling an unbooked occurrence succeeds; cancelling one with confirmed reservations is refused and states why. |
| SC-10 | Every catalog mutation writes a `staff_audit_log` row naming the actor, action, and entity. |
| SC-11 | An audit entry never survives a mutation that rolled back. |
| SC-12 | Every admin action rejects a caller whose role is below `MANAGER`. |
| SC-13 | `/admin/offerings` lists offerings with status and supports create, edit, publish, and archive. |
| SC-14 | `/admin/schedules` lists upcoming occurrences by day with booked counts, and supports scheduling and cancellation. |
| SC-15 | `/admin/reservations` shows who is booked on an occurrence, with participant names. |
| SC-16 | Playwright covers creating and publishing a class, scheduling it, and seeing it appear on `/book`. |
