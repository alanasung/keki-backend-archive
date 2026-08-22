# WS-01: Contracts — offering status transitions, admin input schemas, audit types

## Goal

Add the vocabulary the admin surface needs: a transition table that makes
`DRAFT → PUBLISHED → ARCHIVED` enforceable rather than decorative, input
schemas for offerings and occurrences that exclude the fields the commands
derive, and the audit action constants for `staff_audit_log`.

`offerings.status` has been an enum since Phase 1 with nothing guarding the
moves between its values. `staff_audit_log` has existed just as long with no
type describing an entry, because nothing has ever written one.

Types and schemas only. No runtime behavior beyond schema definitions.

## Traceability

- **SC-03** — Partially: defines the transition table that makes an undeclared
  offering transition refusable. WS-02 enforces it.
- **SC-10** — Partially: defines the audit action constants and entry type
  every mutation records against.

## Dependencies

None. This is the root of the program.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries"; a type crossing a package boundary belongs
  in `contracts`, not duplicated at both ends
- `docs/vision.md` — "Core Concepts", particularly Offering and Occurrence
- `packages/contracts/src/orders.ts` — `ORDER_TRANSITIONS` and `canTransition`,
  the pattern this workstream mirrors
- `packages/contracts/src/entities.ts` — `OFFERING_STATUSES`,
  `OCCURRENCE_STATUSES`, `OFFERING_TYPES`, and the `Offering`/`Occurrence`
  interfaces
- `packages/contracts/src/catalog.ts` — the cart and view types, for the
  strict-parsing convention new schemas should follow
- `packages/database/src/schema/audit.ts` — the `staff_audit_log` columns the
  audit type must match
- `packages/contracts/src/index.ts` — the barrel

## Package

`packages/contracts`

## Files Touched

- `packages/contracts/src/admin.ts` (NEW) — transition table, admin input schemas, audit types
- `packages/contracts/src/index.ts` (MODIFY — export the new module)
- `packages/contracts/src/admin.test.ts` (NEW)

## Existing Interfaces to Consume

The order transition table this mirrors. Same shape, same reasoning — the
machine is data, not scattered conditionals:

```ts
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAID', 'CANCELLED', 'EXPIRED'],
  PAID: [],
  CANCELLED: [],
  EXPIRED: [],
} as const;

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
```

The status and type constants already in `entities.ts`:

```ts
export const OFFERING_TYPES = ['CLASS', 'ROOM', 'OPEN_PLAY'] as const;
export type OfferingType = (typeof OFFERING_TYPES)[number];

export const OFFERING_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export const OCCURRENCE_STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
```

The `offerings` table, whose columns the input schema is derived from — note
`slug` is unique and `status` defaults to `DRAFT`:

```ts
export const offerings = pgTable('offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  type: offeringTypeEnum('type').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  status: offeringStatusEnum('status').notNull().default('DRAFT'),
});
```

The `staff_audit_log` table the audit type must match exactly:

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

## Implementation Steps

1. **Add the offering transition table** in `admin.ts`:

   ```ts
   export const OFFERING_TRANSITIONS: Readonly<Record<OfferingStatus, readonly OfferingStatus[]>> = {
     DRAFT: ['PUBLISHED', 'ARCHIVED'],
     PUBLISHED: ['DRAFT', 'ARCHIVED'],
     ARCHIVED: [],
   } as const;

   export function canTransitionOffering(from: OfferingStatus, to: OfferingStatus): boolean;
   ```

   `PUBLISHED → DRAFT` is permitted deliberately: unpublishing is how staff
   pull a class off sale without destroying it, and `createOrder` already
   re-validates that an offering is published, so a customer mid-checkout
   fails cleanly rather than buying an unpublished class.

   `ARCHIVED` is terminal. Un-archiving would let a slug and price return to
   sale long after anyone remembers why it was retired; re-creating is the
   deliberate path.

2. **Add the occurrence transition table** in the same file:

   ```ts
   export const OCCURRENCE_TRANSITIONS: Readonly<Record<OccurrenceStatus, readonly OccurrenceStatus[]>> = {
     SCHEDULED: ['CANCELLED', 'COMPLETED'],
     CANCELLED: [],
     COMPLETED: [],
   } as const;

   export function canTransitionOccurrence(from: OccurrenceStatus, to: OccurrenceStatus): boolean;
   ```

3. **Add the offering input schema.** It must omit `slug`, `status`, `id`, and
   the timestamps:

   ```ts
   export const createOfferingSchema = z.object({
     name: z.string().trim().min(1).max(120),
     description: z.string().trim().max(2000).nullable(),
     type: z.literal('CLASS'),
     durationMinutes: z.number().int().min(5).max(600),
     defaultCapacity: z.number().int().min(1).max(500),
     priceCents: z.number().int().min(0).max(10_000_00),
     currency: z.string().length(3).default('USD'),
   }).strict();

   export type CreateOfferingInput = z.infer<typeof createOfferingSchema>;

   export const updateOfferingSchema = createOfferingSchema.partial().strict();
   ```

   Three omissions, each deliberate:

   - **`slug`** is derived by the command. If it were an input, two staff
     entering the same class name would collide at insert time with a
     constraint error they cannot act on.
   - **`status`** moves only through the transition table. Accepting it as a
     field would let a caller set `ARCHIVED` directly and bypass step 1
     entirely.
   - **`id` and timestamps** are the database's.

   `type` is `z.literal('CLASS')` rather than the full enum: rooms and open
   play are not bookable on the customer surface, so creating them would
   produce offerings with no path to purchase. Using the literal makes that a
   parse failure rather than a runtime check someone can forget.

   `priceCents` is an integer with a ceiling. Money stays in integer cents
   everywhere, exactly as WS-01 of the previous program established.

4. **Add the occurrence input schema**, omitting `endsAt` and `status`:

   ```ts
   export const scheduleOccurrenceSchema = z.object({
     offeringId: z.string().uuid(),
     startsAt: z.coerce.date(),
     capacityOverride: z.number().int().min(1).max(500).nullable(),
   }).strict();

   export const updateOccurrenceSchema = z.object({
     startsAt: z.coerce.date().optional(),
     capacityOverride: z.number().int().min(1).max(500).nullable().optional(),
   }).strict();
   ```

   `endsAt` is absent because the command computes it from the offering's
   `durationMinutes`. Accepting both a start and an end would let them
   disagree with the offering's stated duration, and nothing downstream would
   know which to believe.

5. **Add the audit vocabulary**:

   ```ts
   export const AUDIT_ACTIONS = [
     'offering.created',
     'offering.updated',
     'offering.published',
     'offering.unpublished',
     'offering.archived',
     'occurrence.scheduled',
     'occurrence.updated',
     'occurrence.cancelled',
   ] as const;
   export type AuditAction = (typeof AUDIT_ACTIONS)[number];

   export const AUDIT_ENTITY_TYPES = ['offering', 'occurrence'] as const;
   export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

   export interface AuditEntry {
     readonly id: StaffAuditLogEntryId;
     readonly actorCustomerId: CustomerId;
     readonly action: AuditAction;
     readonly entityType: AuditEntityType;
     readonly entityId: string;
     readonly before: Record<string, unknown> | null;
     readonly after: Record<string, unknown> | null;
     readonly occurredAt: Date;
   }
   ```

   Actions are a closed set rather than free text so a reader can enumerate
   what is auditable, and so a typo becomes a compile error instead of an
   entry nobody will ever find.

   Publishing and unpublishing get distinct actions even though both are a
   status transition. "Who took this off sale, and when" is the question an
   audit log exists to answer, and `offering.updated` would bury it.

6. **Export from the barrel** and run all four scripts, then `pnpm -r typecheck`.

## Tests

1. **`canTransitionOffering` permits declared edges** — Assert
   `DRAFT → PUBLISHED`, `PUBLISHED → ARCHIVED`, and `PUBLISHED → DRAFT` are
   all allowed.
2. **`canTransitionOffering` refuses undeclared edges** — Assert
   `ARCHIVED → PUBLISHED` and `ARCHIVED → DRAFT` are both `false`.
3. **`ARCHIVED` is terminal** — Assert `OFFERING_TRANSITIONS.ARCHIVED` is
   empty.
4. **Offering transition table covers every status** — Assert
   `Object.keys(OFFERING_TRANSITIONS)` equals `OFFERING_STATUSES`, so adding a
   status without a rule fails the build rather than silently denying all
   moves.
5. **Occurrence transitions permit only cancel and complete from SCHEDULED** —
   Assert both allowed, and `CANCELLED → SCHEDULED` refused.
6. **Occurrence transition table covers every status** — Same assertion as
   test 4, for `OCCURRENCE_STATUSES`.
7. **`createOfferingSchema` rejects a supplied slug** — Parse an input
   carrying `slug: 'x'`; assert failure. This is what keeps slug generation
   authoritative.
8. **`createOfferingSchema` rejects a supplied status** — Parse an input
   carrying `status: 'ARCHIVED'`; assert failure.
9. **`createOfferingSchema` rejects a non-CLASS type** — Assert `'ROOM'` and
   `'OPEN_PLAY'` both fail, and `'CLASS'` passes.
10. **Duration bounds are enforced** — Assert `4` and `601` fail; `5` and `600`
    pass.
11. **Capacity must be at least one** — Assert `0` and `-1` fail; `1` passes.
12. **`priceCents` rejects a non-integer** — Assert `4.5` fails, proving money
    cannot arrive as a fractional value. Assert `0` passes, since a free class
    is legitimate.
13. **Name is trimmed and non-empty** — Assert `'   '` fails and `'  Pottery '`
    parses to `'Pottery'`.
14. **`scheduleOccurrenceSchema` rejects a supplied endsAt** — Parse an input
    carrying `endsAt`; assert failure. The command derives it.
15. **`scheduleOccurrenceSchema` coerces an ISO string to a Date** — Assert a
    string input yields a `Date`, since form submissions arrive as strings.
16. **`capacityOverride` accepts null** — Assert `null` parses, since "no
    override, use the offering default" is a real state distinct from absent.
17. **`AUDIT_ACTIONS` is frozen `as const`** — Mirror the existing
    `entities.test.ts` assertions for constant arrays.
18. **Publish and unpublish are distinct actions** — Assert both
    `offering.published` and `offering.unpublished` exist in `AUDIT_ACTIONS`.

## Acceptance Criteria

1. `packages/contracts` passes all four scripts, and `pnpm -r typecheck` passes
   workspace-wide.
2. `OFFERING_TRANSITIONS` covers every `OFFERING_STATUSES` member, permits
   `PUBLISHED → DRAFT`, and leaves `ARCHIVED` terminal (tests 1–4).
3. `OCCURRENCE_TRANSITIONS` covers every `OCCURRENCE_STATUSES` member (tests 5–6).
4. `createOfferingSchema` makes `slug` and `status` **unrepresentable** as
   inputs, and accepts only `CLASS` (tests 7–9).
5. `scheduleOccurrenceSchema` makes `endsAt` unrepresentable and coerces date
   strings (tests 14–15).
6. Every schema parses strictly, rejecting unknown keys rather than stripping
   them.
7. `AUDIT_ACTIONS` is a closed set with distinct publish and unpublish entries,
   and `AuditEntry` matches the `staff_audit_log` columns.
8. Money is integer cents throughout; no schema accepts a fractional amount.
9. No runtime behavior beyond schema and table definitions is added.
