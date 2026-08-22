# WS-04: Audit logging — transactional `staff_audit_log` writes for every mutation

## Goal

Write the first rows `staff_audit_log` has ever held.

The table has existed since Phase 1 and no code has ever inserted into it. This
workstream adds `recordAuditEntry` and wires it into every catalog mutation, so
a price change, a publish, or a cancellation is attributable to a person.

The governing constraint: **the audit entry commits with the change or not at
all.** An entry written after the transaction can be lost while the change
survives, and a log that silently misses entries is worse than no log, because
it implies a completeness it does not have.

## Traceability

- **SC-10** — Every catalog mutation writes a `staff_audit_log` row naming the
  actor, action, and entity.
- **SC-11** — An audit entry never survives a mutation that rolled back.

## Dependencies

- **WS-01** — Contracts (`AUDIT_ACTIONS`, `AuditEntry`).
- **WS-02** — catalog-admin (the offering commands this wraps).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"
- `docs/vision.md` — "Core Concepts"; the staff and admin personas
- `packages/database/src/schema/audit.ts` — the `staff_audit_log` columns
- `packages/database/src/transaction.ts` — `withTransaction` and `Tx`, and its
  note that a caller already holding a `Tx` must use it rather than nesting
- `packages/contracts/src/admin.ts` — WS-01's `AUDIT_ACTIONS` and `AuditEntry`
- `packages/catalog-admin/src/offerings.ts` — WS-02's commands and their
  optional `tx` parameter
- `packages/catalog-admin/src/occurrences.ts` — WS-03's commands
- `packages/commerce-core/src/orders.ts` — how `createOrder` threads one
  transaction through an injected port, the precedent for composing writes
  atomically

## Package

`packages/catalog-admin`

## Files Touched

- `packages/catalog-admin/src/audit.ts` (NEW)
- `packages/catalog-admin/src/offerings.ts` (MODIFY — record entries)
- `packages/catalog-admin/src/occurrences.ts` (MODIFY — record entries)
- `packages/catalog-admin/src/index.ts` (MODIFY — barrel)
- `packages/catalog-admin/src/audit.test.ts` (NEW)

## Existing Interfaces to Consume

The table. Every column is either supplied by the caller or defaulted; note
`actorCustomerId` is `notNull` and a real foreign key, so an audit entry cannot
be anonymous:

```ts
export const staffAuditLog = pgTable('staff_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorCustomerId: uuid('actor_customer_id').notNull().references(() => customers.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: inet('ip_address'),
});
```

WS-01's closed action set:

```ts
export const AUDIT_ACTIONS = [
  'offering.created', 'offering.updated', 'offering.published',
  'offering.unpublished', 'offering.archived',
  'occurrence.scheduled', 'occurrence.updated', 'occurrence.cancelled',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
```

The transaction helper, whose doc comment states the rule this workstream
depends on:

```ts
/**
 * Opens a real Postgres transaction (BEGIN/COMMIT/ROLLBACK) ... Callers that
 * already hold a `Tx` — e.g. a `TransactionScope` handed down from an outer
 * transaction — should use it directly rather than nesting a new one.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
```

WS-02's command shape — each already accepts the optional `tx` this workstream
requires:

```ts
export async function createOffering(input: {
  data: CreateOfferingInput;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<Offering>;

export async function updateOffering(input: {
  offeringId: OfferingId;
  data: UpdateOfferingInput;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<{ before: Offering; after: Offering }>;
```

## Implementation Steps

1. **Implement `recordAuditEntry`** in `audit.ts`:

   ```ts
   export async function recordAuditEntry(input: {
     executor: Tx;
     actorCustomerId: CustomerId;
     action: AuditAction;
     entityType: AuditEntityType;
     entityId: string;
     before?: Record<string, unknown> | null;
     after?: Record<string, unknown> | null;
   }): Promise<void>;
   ```

   **`executor` is required, not optional.** Making it optional would let a
   caller omit it and get a separate connection, which is exactly the failure
   this workstream exists to prevent — and the omission would be invisible in
   review and in every green test. A required parameter makes the atomic path
   the only path.

   The function performs one insert on the supplied executor. It opens no
   transaction of its own and never calls `withTransaction`.

2. **Add a diff helper** in the same file:

   ```ts
   function changedFields<T extends Record<string, unknown>>(
     before: T,
     after: T,
   ): { before: Partial<T>; after: Partial<T> };
   ```

   Record only the fields that actually changed, not whole rows. A price
   change should read as a price change; storing both full rows makes a reader
   diff them by eye to answer "what changed", which is the question the log
   exists to answer.

   Exclude `updatedAt` from the diff — it changes on every write and would
   appear in every entry, adding noise and no information.

3. **Wire the offering commands** in `offerings.ts`. Inside each command's
   existing transaction, after the write:

   - `createOffering` → `offering.created`, `after` being the created row's
     meaningful fields, `before` null.
   - `updateOffering` → `offering.updated`, with the `changedFields` diff. Skip
     the entry entirely when nothing changed — an edit that changed nothing is
     not an event.
   - `transitionOffering` → `offering.published`, `offering.unpublished`, or
     `offering.archived`, chosen by the target status. Skip when
     `changed` is `false`, since an idempotent repeat is not a second event.

   Distinct actions for publish and unpublish, not a generic update: "who took
   this off sale" is precisely the question this table answers.

4. **Wire the occurrence commands** in `occurrences.ts` the same way:
   `occurrence.scheduled`, `occurrence.updated`, `occurrence.cancelled`, each
   inside the command's existing transaction, each skipping no-op writes.

5. **Do not add an audit reader.** This program writes entries; displaying them
   is a separate surface with its own filtering and pagination questions, and
   is explicitly out of scope.

6. **Run all four scripts** and `pnpm -r typecheck`.

## Tests

All database tests are `describe.skipIf(!hasLiveDatabase)`, isolated by
per-test `crypto.randomUUID()` identifiers.

1. **`createOffering` writes one entry** _(integration)_ — Assert exactly one
   `staff_audit_log` row, with `action: 'offering.created'`, `entityType:
   'offering'`, and `entityId` equal to the new offering's id. **This is
   SC-10.**
2. **The entry names the actor** _(integration)_ — Assert `actorCustomerId`
   equals the customer passed in, not a default or null.
3. **`createOffering` records the created values in `after`** _(integration)_ —
   Assert `after` contains the name and `priceCents`, and `before` is null.
4. **A rolled-back create leaves no entry** _(integration)_ — Force the
   offering insert to fail inside the transaction; assert **zero** audit rows
   and zero offering rows. **This is SC-11, and the test that proves the entry
   is inside the transaction rather than beside it.**
5. **A rolled-back update leaves no entry** _(integration)_ — Same shape for
   `updateOffering`; assert the audit table is unchanged and the offering
   retains its original values.
6. **`updateOffering` records only changed fields** _(integration)_ — Change
   only the price; assert the diff contains `priceCents` and does **not**
   contain `name`.
7. **`updatedAt` is excluded from the diff** _(integration)_ — Assert it
   appears in neither `before` nor `after`, since it changes on every write.
8. **A no-op update writes no entry** _(integration)_ — Call `updateOffering`
   with the values it already has; assert no new audit row.
9. **Publishing writes `offering.published`** _(integration)_ — Assert the
   action, distinguishing it from `offering.updated`.
10. **Unpublishing writes `offering.unpublished`** _(integration)_ — Assert the
    distinct action, so "who took this off sale" is answerable.
11. **Archiving writes `offering.archived`** _(integration)_.
12. **An idempotent transition writes no second entry** _(integration)_ —
    Publish twice; assert exactly one `offering.published` row.
13. **`scheduleOccurrence` writes `occurrence.scheduled`** _(integration)_ —
    Assert action, `entityType: 'occurrence'`, and the occurrence id.
14. **`cancelOccurrence` writes `occurrence.cancelled`** _(integration)_.
15. **A refused cancellation writes no entry** _(integration)_ — Attempt to
    cancel an occurrence with confirmed reservations; assert it throws and no
    audit row exists. A refusal is not an event.
16. **`updateOccurrence` records the capacity change** _(integration)_ — Lower
    `capacityOverride`; assert the diff carries the old and new values.
17. **`recordAuditEntry` requires an executor** — A `@ts-expect-error` case
    asserting a call omitting `executor` does not compile. This is what stops
    a future caller from silently writing outside the transaction.
18. **Every mutation is covered by an action** — Assert every value in
    `AUDIT_ACTIONS` is emitted by at least one command, so a declared action
    with no writer is caught.

## Acceptance Criteria

1. `packages/catalog-admin` passes all four scripts, and `pnpm -r typecheck`
   passes workspace-wide.
2. `recordAuditEntry` takes a **required** executor, performs a single insert
   on it, and never opens a transaction of its own (test 17).
3. Every catalog mutation writes exactly one entry naming actor, action, and
   entity (tests 1–3, 9–11, 13–14). **SC-10.**
4. No audit entry survives a rolled-back mutation, for both creates and updates
   (tests 4–5). **SC-11.**
5. Update entries record only the fields that changed, excluding `updatedAt`
   (tests 6–7).
6. No-op writes, idempotent transitions, and refused operations produce no
   entry (tests 8, 12, 15).
7. Publish, unpublish, and archive are recorded as distinct actions rather than
   a generic update (tests 9–11).
8. No audit-reading surface is added.
