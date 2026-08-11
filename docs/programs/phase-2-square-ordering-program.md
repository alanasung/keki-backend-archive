# keki-backend-prod — Program Plan (Phase 2 Square Ordering)

> **Revision 2** (2026-08-10). Replanned after validation returned
> `requires-replan` with 2 blockers and 8 majors against revision 1. The
> structural changes are recorded in "Revision history" at the end; the most
> consequential are that class seats now carry explicit participants, seat
> holding moved inside order creation, and the critical path now runs through
> capacity rather than catalog.

## Program Overview

**Product:** Keki is the commerce and operations platform for a cafe that runs
classes, rents rooms, and hosts open play. One Next.js 15 application on AWS
serves four surfaces — customer, kiosk, staff, admin — over a set of plain
TypeScript domain packages, with Square for payments, a waiver provider for
liability signing, and Klaviyo/SES/SMS for customer communication.

**Program scope:** Turn the Phase 1 skeleton into a system that takes money.
Implement a real Square integration — Catalog as the menu source of truth,
Square-hosted checkout, and correct webhook signature verification — and ship a
customer-facing ordering page that displays cafe items and bookable classes.
Buying a class seat assigns a named household member to that seat and creates a
real reservation, which requires building the reservation capacity enforcement
Phase 1 deliberately deferred.

This is the first program that produces Server Actions, the first that moves
money, and the first that exposes a public HTTP ingress. All three are
load-bearing and are treated as such below.

## Strategic Goals

1. **Make Square the menu source of truth, not a second copy.** Staff manage
   items and prices in the Square dashboard they already use for the register,
   so a price can never disagree between the counter and the website.
2. **Take money without holding card data.** Square-hosted checkout keeps the
   card form on Square's origin, so this program stays out of PCI SAQ-A-EP
   scope while still completing a real purchase.
3. **Make a seat count mean something, and know who is in it.** Capacity is
   enforced at the database level, and every seat names the household member who
   occupies it — the record check-in and waivers will later depend on.
4. **Close the webhook security gap before it is reachable.** Phase 1's generic
   HMAC check was safe only because the Function URL was IAM-authed. This
   program makes that endpoint public, so Square's real signature scheme must
   land in the same change.
5. **Establish the Server Action pattern once.** The app has none today. This
   program sets the authenticated-mutation shape every later surface copies.

## Architecture Changes

Changes from the system described in `docs/as-built.md`. Everything not listed
here is unchanged.

**Two new packages.**

- `packages/square-client` — the production implementation of the
  `SquareClient` interface, wrapping the Square SDK. It exists as its own
  package because `AGENTS.md` forbids a core package from depending on a vendor
  SDK. Domain code keeps depending on the interface in `contracts`, and only the
  composition root wires the concrete client.
- `packages/catalog-core` — read paths for the sellable catalog: cached Square
  items plus published offerings and their upcoming occurrences.

**Seat holding is injected into order creation, not called beside it.**
Creating an order and holding its seats must be one atomic act — a paid order
whose seats were never held, or held seats with no order, are both broken
states. But `commerce-core` may not import `reservation-core`: the established
boundary is that each core depends on `contracts` and `database` only.

So `createOrder` accepts a `SeatHolder` port defined in `contracts`, and the
composition root injects `reservation-core`'s implementation. This is the same
dependency inversion the codebase already uses for `SquareClient` and
`NotificationProviders`, applied to a core-to-core need. Both cores accept an
optional transaction handle so the orchestration is genuinely atomic.

**Class seats carry participants.** A cart line for a class names the household
members who will occupy the seats, not just a quantity. `holdReservation`
already requires participant records, `reservation_participants` already
enforces customer-XOR-child, and `docs/vision.md` describes a child as "the
subject of many reservations." A quantity alone cannot produce a valid hold, and
recording the purchasing adult as the attendee would be wrong at check-in and
wrong for waivers.

Seat quantity is therefore **derived** from the participant selection rather
than typed by the customer.

**`SquareClient` widens.** `createCheckout` currently requires a
`reservationId`, which assumes every payment is a booking. A cafe order has no
reservation. The interface changes to take an order id plus line items, and
`verifyWebhookSignature` gains the notification URL Square's scheme signs.

**Orders become a first-class concept.** `payment_records` records that money
moved; it cannot express *what was bought*. Two new tables — `orders` and
`order_line_items` — sit between the cart and the payment. A line item points at
either a cached Square catalog item or an occurrence, never both.

**Catalog is cached, not proxied.** A `catalog_items` cache table is refreshed
by the existing `scheduled-task-worker` on a schedule and on
`catalog.version.updated` webhooks. Pages read Postgres.

**Prices are never trusted from the client.** The cart submits item ids,
participant ids, and quantities only. Server Actions recompute every amount from
the cache, and Square independently computes the authoritative total.

**Capacity moves into the database.** `reservations` gains the constraint Phase 1
left out, enforced by a trigger that locks the occurrence before counting.

**There is one composition root for the web app.** A single server-only module
constructs the production `SquareClient` and `SeatHolder`. Revision 1 left this
unspecified, which meant checkout had no defined way to reach Square in
production.

**The webhook notification URL is configured, not derived.** It is a per-stage
secret, asserted after deploy to match the actual Function URL. Deriving it from
the function's own URL output is circular — the URL is created *from* the
function.

**The Square webhook Function URL becomes public.** Auth changes from
`AWS_IAM` to `NONE`, gated on the real signature verification landing first.

## Technology Choices

| Decision | Choice | Rationale |
| --- | --- | --- |
| Square SDK | Official `square` Node SDK, pinned | Handles request signing and pagination; hand-rolling Catalog and Orders is avoidable risk. |
| Checkout surface | Square-hosted Checkout (Payment Links) | Keeps the card form off our origin and out of PCI SAQ-A-EP scope. |
| Catalog freshness | Cached in Postgres; scheduled refresh + webhook invalidation | Square Catalog is not on the render path. Staleness is bounded and observable. |
| Cart storage | Signed HTTP-only cookie, server-recomputed | No cart table and no stale cart rows. Amounts are recomputed server-side regardless of cookie contents. |
| Core-to-core composition | Injected ports (`SeatHolder`), not direct imports | Preserves the contracts+database-only rule for cores while allowing atomic multi-core operations. |
| Tax and totals | Square computes the authoritative total | Square already owns tax configuration for the register. |
| Capacity enforcement | DB constraint + serialized transaction | An application-level check cannot prevent two concurrent orders overselling the last seat. |
| Notification URL | Per-stage secret + post-deploy assertion | The derived alternative is a self-reference; the assertion catches drift. |

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
| --- | --- | --- | --- |
| WS-01 | Contracts: catalog, cart, order types; `SeatHolder`; widened `SquareClient` | — | M |
| WS-02 | Database: orders, line items, catalog cache, capacity constraint | WS-01 | M |
| WS-03 | `square-client`: production Square adapter and signature verification | WS-01 | L |
| WS-04 | `catalog-core`: catalog cache sync and read paths | WS-02, WS-03 | M |
| WS-05 | `commerce-core`: order lifecycle, seat holding, real `startCheckout` | WS-02, WS-03, WS-06 | L |
| WS-06 | `reservation-core`: capacity enforcement, holds, and expiry | WS-02 | L |
| WS-07 | Server Action foundation and authenticated mutation wrapper | WS-01 | S |
| WS-08 | Ordering page: cafe menu and class listing | WS-04, WS-07 | M |
| WS-09 | Cart, participant selection, and review page | WS-05, WS-06, WS-08 | M |
| WS-10 | Webhook fulfillment: confirm orders and reservations on payment | WS-03, WS-04, WS-05, WS-06 | M |
| WS-11 | Infrastructure: Square secrets, catalog schedule, public Function URL | WS-03, WS-04, WS-06, WS-10 | S |
| WS-12 | Test coverage, end-to-end specs, and documentation | WS-10, WS-11, WS-13 | M |
| WS-13 | Checkout action, Square composition root, and order status page | WS-05, WS-09 | M |

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

### Workstream detail

- **WS-01** — Catalog, cart, and order types and schemas. The occurrence cart
  line carries participant references rather than a bare quantity. Adds the
  `SeatHolder` port. Widens `SquareClient.createCheckout` off its `reservationId`
  assumption and adds `notificationUrl` to signature verification.
- **WS-02** — `orders`, `order_line_items`, `catalog_items`, and the
  `reservations` capacity constraint with its trigger and `seat_count` column.
  Applied against a real Neon branch.
- **WS-03** — The Square adapter: paginated catalog reads, Payment Links,
  payment retrieval, refunds, and **Square's real signature scheme** (HMAC over
  notification URL plus raw body). Replaces the Phase 1 generic HMAC.
- **WS-04** — Catalog sync into the cache with tombstoning, plus the cafe-item
  and bookable-occurrence read paths with `seatsRemaining`. Wires
  `catalog.sync` into `scheduled-task-worker`.
- **WS-05** — `createOrder` resolving every amount server-side, holding seats
  through the injected `SeatHolder` in the same transaction, and writing each
  resulting `reservationId` onto its line item. Order state machine and the real
  `startCheckout`.
- **WS-06** — Real `holdReservation`, `confirmReservation`, `cancelReservation`
  on top of the WS-02 trigger, accepting a transaction handle so WS-05 can
  compose atomically. Hold expiry sweep. Concurrency is proved, not assumed.
- **WS-07** — The `authenticatedAction` wrapper, typed error envelope, and
  domain-error mapping. Sets the pattern; ships no product behavior.
- **WS-08** — `/book` renders cafe items and class occurrences with prices,
  times, and remaining seats. Read-only.
- **WS-09** — Cart cookie, add/remove/update actions, the **participant picker**
  that assigns household members to class seats, and the review page.
- **WS-10** — Webhook fulfillment: real payload handling keyed on Square's
  echoed order reference, order transition to `PAID`, and reservation
  confirmation that is safe to retry at any point.
- **WS-11** — Square secrets, the notification-URL secret and its post-deploy
  assertion, catalog and expiry schedules, the Function URL auth switch, and a
  signature-failure alarm.
- **WS-12** — Playwright journey, the sandbox payment-to-fulfillment test, the
  integration-suite skip audit, and documentation of every new secret.
- **WS-13** — The checkout action, the single server-only composition root
  constructing the production `SquareClient` and `SeatHolder`, and the order
  status page customers return to from Square.

## Dependency Graph

```
                          WS-01 (contracts)
                     /          |           \
                    /           |            \
        WS-02 (database)   WS-03 (square-client)   WS-07 (actions)
          /      \              |     \                  |
         /        \             |      \                 |
   WS-06        WS-04 (catalog-core)    \                |
 (capacity)        |         \           \               |
     |             |          +-----------+---------> WS-08 (page)
     |             |                                     |
     +---> WS-05 (orders + seat holding) <---------------+
                   |         \
                   |          \
            WS-09 (cart +      +------> WS-10 (fulfillment)
            participants)                    |
                   |                         |
            WS-13 (checkout +                |
            composition root)          WS-11 (infra)
                   |                         |
                   +-----------+-------------+
                               |
                        WS-12 (tests + docs)

WS-05 depends on WS-02, WS-03, and WS-06 — seat holding is part of order creation.
WS-09 depends on WS-05, WS-06, and WS-08.
WS-10 depends on WS-03, WS-04, WS-05, and WS-06.
WS-11 depends on WS-03, WS-04, WS-06, and WS-10.
WS-13 depends on WS-05 and WS-09.
WS-12 depends on WS-10, WS-11, and WS-13.
```

Parallelism: after WS-01, the database spine (WS-02) and the Square adapter
(WS-03) run concurrently, and WS-07 is independent of both. WS-04 and WS-06 fan
out from WS-02 and run in parallel.

## Critical Path

```
WS-01 → WS-02 → WS-06 → WS-05 → WS-09 → WS-13 → WS-12
```

Roughly 35 working days serialized — about 3.5 days longer than revision 1.

**The path moved.** In revision 1 it ran through catalog into the page, and
WS-06 carried four days of slack. Making seat holding part of order creation put
capacity directly on the path: WS-05 cannot start until WS-06 exists, and
everything customer-facing queues behind WS-05.

That is the correct shape, but it concentrates risk badly. WS-06 is both the
workstream most likely to overrun — concurrency correctness is hard to prove —
and now the one everything waits on. Three consequences worth planning for:

1. **WS-06 is the schedule.** A day lost there is a day lost overall. Start it
   the moment WS-02 lands, ahead of WS-04 if resources are contended.
2. **WS-03 dropped off the path** but still gates WS-10 and WS-11. It has about
   four days of slack now; do not let that invite delay, because the Function
   URL change queues behind it.
3. Square Developer Dashboard setup, sandbox credentials, and webhook
   subscription depend on nothing in this repository. Do them during WS-01.

## Scope (In)

- Production `SquareClient` implementation in a dedicated package
- Square's real webhook signature verification, replacing Phase 1 generic HMAC
- Square Catalog sync into a Postgres cache, scheduled and webhook-invalidated
- `orders` and `order_line_items` tables and the order state machine
- Reservation capacity enforcement at the database level, holds, and expiry
- Participant selection assigning household members to class seats
- Server Action foundation with an authenticated mutation wrapper
- Ordering page displaying cafe items and bookable classes with live seat counts
- Cart in a signed cookie with server-recomputed amounts
- A single server-only composition root for production clients
- Square-hosted checkout, redirect, and order status page
- Payment webhook fulfillment confirming orders and reservations
- Square secrets, catalog and expiry schedules, and public Function URL in SST
- Unit, integration, sandbox, and Playwright coverage for the above

## Scope (Out)

Explicitly deferred — do not implement in this program:

- Guest and kiosk ordering (signed-in customers only this program)
- Embedded card entry via the Square Web Payments SDK
- Room and open-play booking (classes only; rooms remain display-only)
- Adding or editing household members during checkout — the picker selects from
  existing children and customers only
- Play-pass purchase or draw-down at checkout
- Refunds and cancellation flows in the customer UI
- An admin UI for the menu — Square's dashboard is the menu admin
- Real `reconciliation-worker` comparison logic; it stays a skeleton
- Waiver signing at the point of class purchase
- Klaviyo order-confirmation flows — the outbox is written, providers stay no-op
- Inventory tracking or item-level stock
- Order modification after payment

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Function URL goes public before real signature verification lands | **Critical** — an unauthenticated endpoint that writes payment records | WS-11 depends on WS-10, which depends on WS-03. The dependency is declared in the manifest, not only in prose — revision 1's failure was exactly this gap. |
| Client-submitted prices are trusted | **Critical** — a customer sets their own price | Cart carries ids, participants, and quantities only. Server recomputes; Square computes the authoritative total. Asserted by a WS-09 test posting a tampered cart. |
| Two concurrent orders oversell the last seat | High — real overbooking | Enforced by a database trigger holding a row lock. WS-06 proves it with concurrent transactions, and asserts exactly one *confirmed* seat after payment, not merely one held row. |
| Order created but seats not held, or seats held with no order | High — money and entitlement disagree | `createOrder` holds seats through the injected `SeatHolder` inside one transaction. Neither can exist without the other. |
| Fulfillment retried after the PAID transition skips confirmations | High — customer pays, seat never confirms | WS-10 confirms reservations whenever the order **is** `PAID`, never gated on whether the transition changed it. Asserted by a mid-fulfillment crash test. |
| Catalog cache serves a stale price | High — advertised price differs from charged | Square computes the authoritative total, so the customer is never charged the stale number. Bound staleness with the schedule plus webhook invalidation, and surface last-synced age. |
| WS-06 overruns and blocks everything downstream | High — it is now on the critical path | Start it immediately after WS-02. Treat its concurrency test as the first deliverable, not the last. |
| Checkout double-submit creates two Square payment links | Medium — duplicate charges | Idempotency keyed on order id; `startCheckout` returns an existing checkout URL rather than creating a second. |
| Payment succeeds but the hold already expired | High — money taken for a resold seat | WS-10 logs at error level, enqueues an outbox notification for staff, leaves the payment standing, and never silently re-holds. The mitigation is that it is loud, not that it cannot happen. |
| Notification URL drifts from Square's registration | High — every genuine delivery rejected, looking identical to an attack | Configured per-stage secret with a post-deploy assertion against the actual Function URL, plus a signature-failure alarm. |
| Participant selection lets a customer book another household's child | **Critical** — privacy breach | The picker loads only the session household's members, and `createOrder` re-validates every participant belongs to that household server-side. Asserted by a WS-05 test submitting a foreign child id. |
| Capacity integration tests silently skip | Medium — a green run that proved nothing | WS-12 ships a CI audit failing when any `integration:` suite reports zero executed tests. |
| Sandbox and production Square credentials transposed | High — test orders against real money | Separate per-stage secrets with a startup assertion that environment and credential mode agree. |

## Success Criteria

| ID | Outcome |
| --- | --- |
| SC-01 | The ordering page lists cafe items sourced from the Square Catalog cache, with name, description, and price. |
| SC-02 | The ordering page lists published class occurrences with start time, price, and remaining seats. |
| SC-03 | A signed-in customer can add cafe items and a class seat to a cart and see a correct recomputed total. |
| SC-04 | Submitting a cart with a tampered price or amount is rejected; the order is created from server-side amounts only. |
| SC-05 | Checkout redirects to a Square-hosted payment page for the created order. |
| SC-06 | A signed payment webhook moves its matching order to `PAID` and writes exactly one `payment_records` row. |
| SC-07 | A paid order containing a class seat confirms its reservation; the seat is no longer offered. |
| SC-08 | Two concurrent holds on a one-seat occurrence yield exactly one held seat, and after payment exactly one confirmed reservation. |
| SC-09 | An expired hold releases its seat and returns it to the available count. |
| SC-10 | Webhook signature verification implements Square's notification-URL-plus-body scheme and rejects a forged signature. |
| SC-11 | The Square webhook Function URL is publicly reachable and rejects unsigned requests. |
| SC-12 | Catalog sync runs on schedule and on `catalog.version.updated`, upserting new items and tombstoning removed ones. |
| SC-13 | Replaying the same payment webhook, or resuming it after a mid-fulfillment crash, produces exactly one payment record and one fulfillment. |
| SC-14 | Server Actions reject unauthenticated callers through the shared `authorize` predicate. |
| SC-15 | Playwright covers browse → participant selection → cart → checkout redirect against a stubbed Square client. |
| SC-16 | `docs/environment.md` documents every new secret and the sandbox/production credential split. |
| SC-17 | Each class seat is assigned to a named household member, and the reservation records that participant. |
| SC-18 | A participant from another household is rejected server-side. |
| SC-19 | Order creation and seat holding are atomic: neither a seatless paid order nor an orderless hold can result. |
| SC-20 | A sandbox payment completed end to end delivers a signed webhook that fulfills its order. |

## Revision history

**Revision 2 (2026-08-10)** — replanned after `converge` returned
`requires-replan`: 2 blockers, 8 majors, critic `gpt-5.6-terra`. Changes:

1. **Class seats carry participants** (was: bare quantity). `holdReservation`
   requires participant records; a quantity could not produce a valid hold. Adds
   SC-17, SC-18, and the participant picker in WS-09.
2. **Seat holding moved inside `createOrder`** via an injected `SeatHolder`
   port. Revision 1 expected WS-09 to attach `reservationId` to line items, but
   defined no command able to write it and no route for `apps/web` to do so
   directly. Adds SC-19; moves WS-06 onto the critical path.
3. **Notification URL is a configured secret** with a post-deploy assertion.
   Revision 1 derived it from the function's own URL output, which is circular.
4. **Checkout split into WS-13** with an explicit composition root. Revision 1
   left production client construction undefined and WS-09 oversized.
5. **Dependencies corrected** — WS-05→WS-06, WS-09→WS-06, WS-10→WS-04,
   WS-11→WS-06/WS-10. Revision 1 asserted several of these in prose while the
   manifest permitted unsafe ordering.
6. **Fulfillment retry fixed** — confirmation now keys on the order being
   `PAID`, not on the transition having changed it. SC-13 extended to cover a
   mid-fulfillment crash.
7. **Test gaps closed** — SC-08 now requires a confirmed reservation, and SC-20
   adds the sandbox payment-to-fulfillment path revision 1 claimed but never
   tested.
