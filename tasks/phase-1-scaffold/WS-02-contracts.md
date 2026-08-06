# WS-02: Contracts — domain types and integration interfaces

## Goal

Create `@keki/contracts`, the package at the bottom of the dependency graph. It
holds the shared domain types for all thirteen entities, the four role
constants, Zod schemas for values that cross a boundary, and the five typed
integration interfaces.

Nothing in this package has runtime behavior beyond schema definitions. It must
not import any other internal package, any vendor SDK, or anything from
`apps/`.

## Traceability

- **SC-11** — All five integration interfaces are defined and referenced, with no production implementation.
- **SC-12** — The four roles exist (type-level definition; WS-04 wires them to Cognito and Postgres).
- **SC-06** — The package compiles independently.

## Dependencies

- **WS-01** — Monorepo foundation and toolchain.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries", "Integrations", and "Delivery" conventions
- `docs/vision.md` — sections "Core Concepts", "Data Model", "API Surface", "Target Users"
- `tsconfig.base.json` — the compiler options this package extends
- `package.json` (root) — the four required scripts every package must define

## Package

`packages/contracts` — published internally as `@keki/contracts`.

## Files Touched

- `packages/contracts/package.json` (NEW)
- `packages/contracts/tsconfig.json` (NEW)
- `packages/contracts/src/index.ts` (NEW) — barrel re-export
- `packages/contracts/src/roles.ts` (NEW) — role constants and predicates
- `packages/contracts/src/ids.ts` (NEW) — branded ID types
- `packages/contracts/src/entities.ts` (NEW) — the thirteen entity types and enums
- `packages/contracts/src/integrations/square.ts` (NEW) — `SquareClient`
- `packages/contracts/src/integrations/waiver.ts` (NEW) — `WaiverProvider`
- `packages/contracts/src/integrations/marketing.ts` (NEW) — `MarketingProvider`
- `packages/contracts/src/integrations/email.ts` (NEW) — `TransactionalEmailProvider`
- `packages/contracts/src/integrations/sms.ts` (NEW) — `SmsProvider`
- `packages/contracts/src/integrations/index.ts` (NEW) — integration barrel
- `packages/contracts/src/errors.ts` (NEW) — shared errors, including `NotImplementedInPhase1`
- `packages/contracts/src/entities.test.ts` (NEW) — schema tests
- `packages/contracts/src/roles.test.ts` (NEW) — role predicate tests

## Existing Interfaces to Consume

No internal packages exist yet. This package sits at the bottom of the graph and
consumes nothing. It must extend the root TypeScript baseline created in WS-01:

```jsonc
// tsconfig.base.json — created by WS-01, extended here
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
  },
}
```

Per the WS-01 source-export convention, this package's manifest points at
TypeScript source rather than a build output:

```jsonc
// packages/contracts/package.json — the shape every packages/* manifest follows
{
  "name": "@keki/contracts",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint src",
    "test": "vitest run",
    "build": "tsc --noEmit -p tsconfig.json",
  },
}
```

## Implementation Steps

1. **Scaffold the package.** Create `package.json` and `tsconfig.json` following
   the shapes above. Dependencies: `zod` only. Dev dependencies: `vitest`,
   `typescript`, ESLint packages. No AWS SDK, no vendor SDK, no React.

2. **Define branded ID types** in `src/ids.ts`. Every entity gets a distinct
   branded string type so a `CustomerId` cannot be passed where a `ChildId` is
   expected:

   ```ts
   declare const brand: unique symbol;
   type Brand<T, B extends string> = T & { readonly [brand]: B };

   export type HouseholdId = Brand<string, 'HouseholdId'>;
   export type CustomerId = Brand<string, 'CustomerId'>;
   // ...one per entity
   ```

   Export a small constructor per ID that validates UUID shape and returns the
   branded type.

3. **Define roles** in `src/roles.ts`:

   ```ts
   export const ROLES = ['CUSTOMER', 'FRONT_OF_HOUSE', 'MANAGER', 'ADMIN'] as const;
   export type Role = (typeof ROLES)[number];
   ```

   Define the role hierarchy as data, not as scattered comparisons —
   `ADMIN > MANAGER > FRONT_OF_HOUSE > CUSTOMER` — and export a single
   `hasAtLeastRole(actual: Role, required: Role): boolean` predicate. WS-04 and
   WS-09 must use this one function rather than writing their own comparisons.

4. **Define domain enums** in `src/entities.ts`. At minimum:
   - `OfferingType`: `CLASS | ROOM | OPEN_PLAY`
   - `OfferingStatus`: `DRAFT | PUBLISHED | ARCHIVED`
   - `OccurrenceStatus`: `SCHEDULED | CANCELLED | COMPLETED`
   - `ReservationStatus`: `HELD | CONFIRMED | CHECKED_IN | CANCELLED | NO_SHOW`
   - `LedgerReason`: `PURCHASE | REDEMPTION | ADJUSTMENT | EXPIRY | REFUND`
   - `PaymentStatus`: `PENDING | AUTHORIZED | CAPTURED | REFUNDED | FAILED`
   - `NotificationChannel`: `EMAIL | SMS | MARKETING`
   - `NotificationStatus`: `PENDING | CLAIMED | SENT | FAILED | DEAD`
   - `WaiverStatus`: `SIGNED | EXPIRED | REVOKED`

   Declare each as a `const` tuple plus a derived union, matching the `ROLES`
   pattern, so WS-03 can reuse them directly as Postgres enum values.

   `CLAIMED` is a non-terminal lease state, not a synonym for "sent". A worker
   moves a row `PENDING → CLAIMED` when it takes ownership, then
   `CLAIMED → SENT` on success or `CLAIMED → PENDING`/`DEAD` on failure. Without
   it, two concurrent workers have no way to reserve a row that is neither
   terminal nor immediately re-claimable, and the outbox double-sends. WS-03
   pairs it with `claimed_at`/`claimed_by` columns and WS-07 implements the
   transitions.

5. **Define the thirteen entity types** in `src/entities.ts`: `Household`,
   `Customer`, `Child`, `Offering`, `Occurrence`, `Reservation`,
   `ReservationParticipant`, `PlayPass`, `PlayPassLedgerEntry`, `WaiverRecord`,
   `PaymentRecord`, `NotificationOutboxEntry`, `StaffAuditLogEntry`.

   These are the shared shapes; WS-03 derives the Drizzle tables to match. Use
   branded IDs for all keys, `Date` for timestamps, and integer minor units
   (`amountCents`) for money — never floating point.

   Encode the `ReservationParticipant` invariant in the type: exactly one of
   `customerId` or `childId` is set. Express it as a discriminated union rather
   than two optional fields, so the impossible state is unrepresentable.

6. **Add Zod schemas** for the values that cross a trust boundary — anything a
   Server Action or webhook accepts. At minimum, schemas for creating a
   reservation, registering a customer, and the Square webhook envelope. Do not
   write a Zod schema for every entity; schemas are for input validation, not
   for restating the type system.

7. **Define the five integration interfaces**, one file each under
   `src/integrations/`. These are the Phase 1 deliverable for SC-11 — interfaces
   only, no implementations, no vendor imports. Each method returns a `Promise`
   and takes a single named-parameter object. Suggested minimum surface:

   ```ts
   // square.ts
   export interface SquareClient {
     createCheckout(input: {
       reservationId: ReservationId;
       amountCents: number;
       currency: string;
       idempotencyKey: string;
     }): Promise<{ checkoutUrl: string; providerPaymentId: string }>;
     getPayment(input: { providerPaymentId: string }): Promise<PaymentRecord | null>;
     refundPayment(input: {
       providerPaymentId: string;
       amountCents: number;
       idempotencyKey: string;
     }): Promise<{ refundId: string }>;
     verifyWebhookSignature(input: { rawBody: string; signature: string }): Promise<boolean>;
   }
   ```

   ```ts
   // waiver.ts
   export interface WaiverProvider {
     createSigningSession(input: {
       householdId: HouseholdId;
       participantName: string;
       returnUrl: string;
     }): Promise<{ signingUrl: string; providerReference: string }>;
     getWaiver(input: { providerReference: string }): Promise<WaiverRecord | null>;
     downloadDocument(input: { providerReference: string }): Promise<Uint8Array>;
   }
   ```

   Define `TransactionalEmailProvider` (`send`) and `SmsProvider` (`send`) in
   the same style.

   `MarketingProvider` needs both its profile-management surface and a delivery
   method, because WS-07's `dispatchNotification` routes `MARKETING` outbox
   entries through it and expects the same `{ providerMessageId }` result every
   channel returns:

   ```ts
   export interface MarketingProvider {
     identify(input: { customerId: CustomerId; traits: Record<string, unknown> }): Promise<void>;
     track(input: {
       customerId: CustomerId;
       event: string;
       properties: Record<string, unknown>;
     }): Promise<void>;
     subscribe(input: { customerId: CustomerId; listId: string }): Promise<void>;
     /** Delivery method — mirrors the email/SMS `send` shape so dispatch is uniform. */
     send(input: {
       to: string;
       templateKey: string;
       payload: Record<string, unknown>;
       idempotencyKey: string;
     }): Promise<{ providerMessageId: string }>;
   }
   ```

   Without `send`, the `MARKETING` branch of `dispatchNotification` has no
   compatible method to call — `identify` and `track` return `void` and take no
   template or idempotency key.

   Every interface must be constructible as a test double with no network
   access.

8. **Define shared errors** in `src/errors.ts`, including the deferral marker
   every skeleton package needs:

   ```ts
   export class NotImplementedInPhase1 extends Error {
     readonly kind = 'NotImplementedInPhase1';
     constructor(feature: string) {
       super(`${feature} is deferred to Phase 2. See docs/vision.md § Scope: Phase 1.`);
     }
   }
   ```

   It lives here, at the bottom of the graph, because WS-06 and WS-07 both throw
   it and run in parallel — if either defined it, the other would have an
   undeclared dependency on a sibling workstream.

   A deferred function throws this rather than returning a fake success. A stub
   that silently returns `{ ok: true }` is worse than no stub: it lets a caller
   be written against behavior that does not exist.

9. **Write the barrel** `src/index.ts` re-exporting ids, roles, entities,
   errors, and the integrations barrel. Keep it a pure re-export — no logic.

10. **Verify.** Run `pnpm --filter @keki/contracts typecheck lint test build`.

## Tests

1. **Role hierarchy is ordered correctly** — For every pair in
   `ADMIN > MANAGER > FRONT_OF_HOUSE > CUSTOMER`, assert
   `hasAtLeastRole(higher, lower) === true` and
   `hasAtLeastRole(lower, higher) === false`.
2. **Role predicate is reflexive** — For each role `r`, assert
   `hasAtLeastRole(r, r) === true`.
3. **Branded IDs reject malformed input** — Assert each ID constructor throws
   (or returns an error result) for a non-UUID string, and accepts a valid v4
   UUID.
4. **Branded IDs are not interchangeable at compile time** — Add a
   `// @ts-expect-error` case asserting a `ChildId` cannot be assigned to a
   `CustomerId`. The test passes only if TypeScript reports the error, which
   makes `typecheck` the assertion.
5. **Participant union forbids the impossible state** — Add `@ts-expect-error`
   cases asserting that a participant with both `customerId` and `childId`, and
   one with neither, both fail to typecheck.
6. **Reservation-create schema rejects bad input** — Assert the Zod schema
   rejects a missing `occurrenceId`, an empty participant list, and a
   non-UUID id; assert it accepts a well-formed payload.
7. **Enum tuples and unions agree** — For each enum, assert every member of the
   `const` tuple is assignable to the derived union and the tuple has no
   duplicates.
8. **No vendor dependency leaks** — Assert `package.json` `dependencies`
   contains only `zod`, guarding the "interfaces, not implementations" rule.

## Acceptance Criteria

1. `packages/contracts` compiles, lints, tests, and builds via all four scripts.
2. `@keki/contracts` has exactly one runtime dependency (`zod`) and zero
   internal dependencies.
3. All thirteen entity types are exported and named as listed in step 5.
4. `ROLES` contains exactly `CUSTOMER`, `FRONT_OF_HOUSE`, `MANAGER`, `ADMIN`,
   and exactly one exported `hasAtLeastRole` predicate encodes the hierarchy.
5. All five integration interfaces — `SquareClient`, `WaiverProvider`,
   `MarketingProvider`, `TransactionalEmailProvider`, `SmsProvider` — are
   exported from `src/integrations/index.ts`.
6. No file in the package imports a vendor SDK, an AWS SDK, React, Next, or any
   other internal package.
7. `ReservationParticipant` is a discriminated union such that setting both or
   neither of `customerId`/`childId` fails to typecheck.
8. Money is represented exclusively as integer minor units; no `number` field
   named for a currency amount is documented as a decimal.
