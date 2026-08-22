import { staffAuditLog, type Tx } from '@keki/database';
import type { AuditAction, AuditEntityType, CustomerId } from '@keki/contracts';

/**
 * Inserts one `staff_audit_log` row on the caller's own executor.
 *
 * `executor` is required, not optional: an optional executor would let a
 * caller omit it and silently get a separate connection, so the entry could
 * commit even when the mutation it describes rolls back (or vice versa).
 * This function never opens a transaction of its own — the caller's
 * existing transaction is the only one that ever runs.
 */
export async function recordAuditEntry(input: {
  executor: Tx;
  actorCustomerId: CustomerId;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<void> {
  await input.executor.insert(staffAuditLog).values({
    actorCustomerId: input.actorCustomerId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
  });
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/**
 * Reduces two same-shaped rows to only the fields that actually changed, so
 * an audit entry reads as "what changed" rather than two full rows a reader
 * must diff by eye. `updatedAt` is excluded on purpose: it changes on every
 * write and would appear in every entry, adding noise and no information.
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { before: Partial<T>; after: Partial<T> } {
  const beforeDiff: Partial<T> = {};
  const afterDiff: Partial<T> = {};

  for (const key of Object.keys(after) as Array<keyof T>) {
    if (key === 'updatedAt') {
      continue;
    }
    if (!fieldsEqual(before[key], after[key])) {
      beforeDiff[key] = before[key];
      afterDiff[key] = after[key];
    }
  }

  return { before: beforeDiff, after: afterDiff };
}
