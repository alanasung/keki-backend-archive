# WS-06: Domain cores — reservation, customer, pass

## Goal

Create three plain TypeScript domain libraries — `@keki/reservation-core`,
`@keki/customer-core`, `@keki/pass-core` — as compiling skeletons with a
declared public surface and test scaffolding.

**This workstream delivers structure, not behavior.** Booking capacity logic and
pass draw-down are explicitly out of scope for Phase 1. Functions declared here
either perform a trivially correct read or throw a `NotImplementedInPhase1`
error. A reviewer finding a non-trivial algorithm in this workstream should
reject it.

## Traceability

- **SC-06** — Every shared package compiles independently.
- **SC-10** — Partially: exercises the WS-03 schema through real queries, proving the tables are usable.
- **SC-11** — Supplies the only Phase 1 reference to `WaiverProvider`, via the deferred `startWaiverSigning` command.

## Dependencies

- **WS-03** — Database (schema and client).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" convention; cores may not import `apps/**` or each other
- `docs/vision.md` — sections "Core Concepts" and "Scope: Phase 1" (note the explicit deferrals)
- `packages/contracts/src/entities.ts` — entity types and enums
- `packages/contracts/src/ids.ts` — branded ID types
- `packages/database/src/schema/index.ts` — table definitions and relations
- `packages/database/src/client.ts` — the exported `db` instance

## Package

Three packages: `packages/reservation-core`, `packages/customer-core`,
`packages/pass-core`.

## Files Touched

**reservation-core**

- `packages/reservation-core/package.json` (NEW)
- `packages/reservation-core/tsconfig.json` (NEW)
- `packages/reservation-core/src/index.ts` (NEW)
- `packages/reservation-core/src/queries.ts` (NEW) — implemented reads
- `packages/reservation-core/src/commands.ts` (NEW) — declared, deferred writes
- `packages/reservation-core/src/errors.ts` (NEW)
- `packages/reservation-core/src/queries.test.ts` (NEW)
- `packages/reservation-core/src/commands.test.ts` (NEW)

**customer-core**

- `packages/customer-core/package.json` (NEW)
- `packages/customer-core/tsconfig.json` (NEW)
- `packages/customer-core/src/index.ts` (NEW)
- `packages/customer-core/src/queries.ts` (NEW)
- `packages/customer-core/src/commands.ts` (NEW)
- `packages/customer-core/src/queries.test.ts` (NEW)

**pass-core**

- `packages/pass-core/package.json` (NEW)
- `packages/pass-core/tsconfig.json` (NEW)
- `packages/pass-core/src/index.ts` (NEW)
- `packages/pass-core/src/balance.ts` (NEW) — ledger fold
- `packages/pass-core/src/commands.ts` (NEW)
- `packages/pass-core/src/balance.test.ts` (NEW)

No file outside these three packages is touched.

## Existing Interfaces to Consume

The deferral marker, created by WS-02 and consumed here — import it, do not
redefine it:

```ts
export class NotImplementedInPhase1 extends Error {
  readonly kind = 'NotImplementedInPhase1';
  constructor(feature: string);
}
```

From `@keki/database` (WS-03):

```ts
export declare const db: NeonHttpDatabase<typeof schema>;

export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurrenceId: uuid('occurrence_id')
    .notNull()
    .references(() => occurrences.id),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  createdByCustomerId: uuid('created_by_customer_id').references(() => customers.id),
  status: reservationStatusEnum('status').notNull(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  // ...
});

export const playPassLedger = pgTable('play_pass_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  playPassId: uuid('play_pass_id')
    .notNull()
    .references(() => playPasses.id),
  deltaCredits: integer('delta_credits').notNull(),
  reason: ledgerReasonEnum('reason').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  // ...
});
```

From `@keki/contracts` (WS-02) — branded IDs and the entity types. The
`ReservationParticipant` discriminated union matters here:

```ts
export type ReservationParticipant =
  | { readonly kind: 'customer'; readonly customerId: CustomerId /* ... */ }
  | { readonly kind: 'child'; readonly childId: ChildId /* ... */ };
```

## Implementation Steps

1. **Consume the deferral error from contracts.** WS-02 exports
   `NotImplementedInPhase1` from `@keki/contracts`:

   ```ts
   export class NotImplementedInPhase1 extends Error {
     readonly kind = 'NotImplementedInPhase1';
     constructor(feature: string) {
       /* ... */
     }
   }
   ```

   Import it; do not redefine it. Deferred functions throw it rather than
   returning a fake success — a stub that silently returns `{ ok: true }` lets a
   caller be written against behavior that does not exist.

2. **Scaffold all three packages** using the WS-01 source-export manifest
   convention. Each depends on `@keki/contracts` and `@keki/database` and on
   nothing else internal. **No core package may depend on another core
   package** — that is the `AGENTS.md` module boundary, and the ESLint rule from
   WS-01 should catch a violation.

3. **reservation-core queries** (`src/queries.ts`) — implement these for real;
   they are simple reads and they prove the schema works:

   ```ts
   export declare function getReservationById(id: ReservationId): Promise<Reservation | null>;

   export declare function listReservationsForOccurrence(
     occurrenceId: OccurrenceId,
   ): Promise<readonly Reservation[]>;

   export declare function listReservationsForHousehold(
     householdId: HouseholdId,
   ): Promise<readonly Reservation[]>;

   /** Count of non-cancelled participants. Reports occupancy; enforces nothing. */
   export declare function countConfirmedParticipants(occurrenceId: OccurrenceId): Promise<number>;
   ```

   `countConfirmedParticipants` is a _report_, not a capacity check. Add a
   comment saying so, because it is the function most likely to be mistaken for
   capacity enforcement in Phase 2.

4. **reservation-core commands** (`src/commands.ts`) — declare the signatures,
   throw `NotImplementedInPhase1`:

   ```ts
   export declare function holdReservation(input: {
     occurrenceId: OccurrenceId;
     householdId: HouseholdId;
     participants: readonly ReservationParticipant[];
   }): Promise<Reservation>; // throws NotImplementedInPhase1

   export declare function confirmReservation(input: {
     reservationId: ReservationId;
   }): Promise<Reservation>; // throws NotImplementedInPhase1

   export declare function cancelReservation(input: {
     reservationId: ReservationId;
     reason: string;
   }): Promise<Reservation>; // throws NotImplementedInPhase1
   ```

   Add a `TODO(phase-2)` comment at the top of the file pointing at the capacity
   rules and stating that `holdReservation` is where the capacity check will
   live.

5. **customer-core queries** (`src/queries.ts`) — implement for real:

   ```ts
   export declare function getCustomerById(id: CustomerId): Promise<Customer | null>;
   export declare function getHouseholdById(id: HouseholdId): Promise<Household | null>;
   export declare function listHouseholdMembers(
     householdId: HouseholdId,
   ): Promise<{ customers: readonly Customer[]; children: readonly Child[] }>;
   ```

6. **customer-core commands** (`src/commands.ts`) — implement
   `provisionCustomerProfile` for real, because WS-04's `unprovisioned` session
   state needs a way out and WS-09 will reach for it:

   ```ts
   export declare function provisionCustomerProfile(input: {
     cognitoSub: string;
     email: string;
     firstName?: string;
     lastName?: string;
   }): Promise<Customer>;
   ```

   It creates a household and a `CUSTOMER`-role customer row in one transaction,
   and is **idempotent on `cognitoSub`** — a repeat call returns the existing
   customer rather than creating a duplicate household. Use the unique
   constraint on `cognito_sub` with an upsert; do not check-then-insert, which
   races.

   Declare `addChild` and `updateHousehold` as deferred.

   Also declare a deferred waiver command that takes the provider by parameter:

   ```ts
   import type { WaiverProvider } from '@keki/contracts';

   export declare function startWaiverSigning(input: {
     waiverProvider: WaiverProvider;
     householdId: HouseholdId;
     participantName: string;
     returnUrl: string;
   }): Promise<{ signingUrl: string }>; // throws NotImplementedInPhase1
   ```

   This is the only place `WaiverProvider` is consumed in Phase 1, and it is
   what makes SC-11's "defined **and referenced**" true for the fifth interface
   rather than only the other four. The body throws; the point is that the
   dependency direction is expressed in compiling code.

7. **pass-core balance** (`src/balance.ts`) — implement the ledger fold for
   real. It is pure, easy to get right, and it is the function that makes the
   append-only ledger meaningful:

   ```ts
   export interface LedgerEntry {
     readonly deltaCredits: number;
     readonly reason: LedgerReason;
     readonly occurredAt: Date;
   }

   /** Sums deltas in chronological order. Pure — no I/O. */
   export declare function computeBalance(entries: readonly LedgerEntry[]): number;

   /** Loads the ledger for a pass and folds it. */
   export declare function getPassBalance(playPassId: PlayPassId): Promise<number>;
   ```

   Keep `computeBalance` pure and separate from `getPassBalance` so the fold is
   testable without a database.

8. **pass-core commands** (`src/commands.ts`) — declare
   `redeemCredits`, `issuePass`, and `expirePass` as deferred, each throwing
   `NotImplementedInPhase1`. Add a `TODO(phase-2)` noting that redemption must
   write a ledger entry and never mutate `remaining_credits` directly, since the
   ledger is the source of truth and the column is a cache.

9. **Write barrels** for each package re-exporting its public surface.

10. **Verify.** Run all four scripts for each of the three packages, and confirm
    `pnpm -r typecheck` still passes workspace-wide.

## Tests

Query tests stub the `db` module. `computeBalance` tests need no stubbing.

1. **`computeBalance` sums an empty ledger to zero** — Assert
   `computeBalance([]) === 0`.
2. **`computeBalance` sums mixed deltas** — Given `+10 PURCHASE`,
   `-1 REDEMPTION`, `-1 REDEMPTION`, `+2 ADJUSTMENT`; assert the result is `10`.
3. **`computeBalance` handles a negative result** — Given `+1` then `-3`; assert
   `-2` rather than a clamp to zero. Phase 2 decides whether negative balances
   are legal; Phase 1 must not silently hide them.
4. **`computeBalance` is order-independent for a sum** — Assert a shuffled
   entry array produces the same total, documenting that the fold is addition
   and not a stateful replay.
5. **`computeBalance` is pure** — Assert it does not mutate the input array
   (compare a deep clone before and after).
6. **Every deferred command throws `NotImplementedInPhase1`** — Table-driven
   over `holdReservation`, `confirmReservation`, `cancelReservation`,
   `addChild`, `updateHousehold`, `startWaiverSigning`, `redeemCredits`,
   `issuePass`, `expirePass`.
   Assert each rejects with an error whose `kind` is `NotImplementedInPhase1`.
   This is the test that keeps the scope boundary honest.
7. **`getReservationById` returns null for an unknown id** — Stub `db` to return
   no rows; assert `null` rather than a throw.
8. **`listReservationsForOccurrence` returns an empty array, not null** — Assert
   the empty case is `[]`, so callers need no null check.
9. **`countConfirmedParticipants` excludes cancelled reservations** — Stub rows
   containing `CANCELLED` and `NO_SHOW` alongside `CONFIRMED`; assert only
   confirmed and checked-in participants are counted.
10. **`provisionCustomerProfile` is idempotent** _(integration)_ — Call it twice
    with the same `cognitoSub`; assert both calls return the same `customerId`
    and that exactly one household row exists afterward.
11. **`provisionCustomerProfile` assigns the `CUSTOMER` role** — Assert a newly
    provisioned profile has role `CUSTOMER`, never an elevated role. A
    provisioning path that could mint an `ADMIN` is a privilege-escalation bug.
12. **No core imports another core** — Assert each of the three `package.json`
    files lists no other `*-core` package in its dependencies.

## Acceptance Criteria

1. All three packages compile, lint, test, and build via their four scripts.
2. No core package depends on another core package, on `apps/**`, or on any
   vendor SDK.
3. `NotImplementedInPhase1` is exported from `@keki/contracts` and thrown by
   every deferred command listed in test 6.
4. No deferred function returns a fabricated success value.
5. `computeBalance` is pure, performs no I/O, and passes tests 1–5.
6. `provisionCustomerProfile` is implemented, transactional, idempotent on
   `cognitoSub`, and always assigns the `CUSTOMER` role.
7. `countConfirmedParticipants` is documented in-source as reporting occupancy,
   not enforcing capacity.
8. `TODO(phase-2)` comments mark the intended homes of capacity enforcement
   (reservation-core commands) and credit redemption (pass-core commands).
9. No capacity check, no pass draw-down, and no payment logic appears in any of
   the three packages.
10. `pnpm -r typecheck` passes workspace-wide after these packages are added.
