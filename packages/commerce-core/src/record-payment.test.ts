import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// recordPaymentFromWebhook is an upsert on a real unique constraint
// (payment_records.provider_payment_id) — there is no meaningful way to fake
// that race with stubs, so this test runs only against a live Neon branch.
// Skipped when those env vars are unset (e.g. locally without Neon
// credentials) and runs in CI once the branch is provisioned. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time — see
// packages/customer-core/src/commands.integration.test.ts for the same
// pattern.
describe.skipIf(!hasLiveDatabase)('integration: recordPaymentFromWebhook', () => {
  it('is idempotent on providerPaymentId and creates exactly one payment_records row', async () => {
    const { recordPaymentFromWebhook } = await import('./record-payment');
    const { db, households } = await import('@keki/database');
    const { createHouseholdId } = await import('@keki/contracts');

    const [household] = await db
      .insert(households)
      .values({ name: `Payment Test Household ${crypto.randomUUID()}` })
      .returning();
    if (household === undefined) {
      throw new Error('setup: failed to insert household');
    }

    const providerPaymentId = `square-${crypto.randomUUID()}`;
    const input = {
      providerPaymentId,
      householdId: createHouseholdId(household.id),
      amountCents: 2500,
      currency: 'USD',
      status: 'CAPTURED' as const,
      rawPayload: { source: 'test' },
      occurredAt: new Date(),
    };

    const first = await recordPaymentFromWebhook(input);
    const second = await recordPaymentFromWebhook(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);

    const { paymentRecords } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(paymentRecords)
      .where(eq(paymentRecords.providerPaymentId, providerPaymentId));
    expect(rows).toHaveLength(1);
  });
});
