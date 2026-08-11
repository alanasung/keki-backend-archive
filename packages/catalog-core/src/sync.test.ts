import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SquareCatalogItem, SquareClient } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// syncCatalog's correctness rests on a real unique-constraint upsert
// (catalog_items.square_variation_id) and on db.batch() actually behaving
// like a transaction — neither is meaningful against a stub db, so this
// whole suite runs against a live Neon branch and is skipped when those env
// vars are unset (e.g. locally without Neon credentials); it runs in CI
// once the branch is provisioned. Uses dynamic imports so a skipped run
// never triggers @keki/database's eager env validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern). Only
// the SquareClient is a stub, per the WS-04 spec's Tests section.
function stubSquareClient(listCatalogItems: SquareClient['listCatalogItems']): SquareClient {
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error('stub SquareClient: method not implemented for this test'));
  return {
    listCatalogItems,
    createCheckout: notImplemented,
    getPayment: notImplemented,
    refundPayment: notImplemented,
    verifyWebhookSignature: notImplemented,
  };
}

function squareItem(overrides: Partial<SquareCatalogItem> = {}): SquareCatalogItem {
  return {
    squareCatalogObjectId: 'object-1',
    squareVariationId: 'variation-1',
    name: 'Latte',
    description: null,
    priceCents: 400,
    currency: 'USD',
    ...overrides,
  };
}

describe.skipIf(!hasLiveDatabase)('integration: syncCatalog', () => {
  beforeEach(async () => {
    const { db, catalogItems } = await import('@keki/database');
    await db.delete(catalogItems);
  });

  it('inserts new items', async () => {
    const { syncCatalog } = await import('./sync');
    const { db, catalogItems } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const squareClient = stubSquareClient(
      vi.fn().mockResolvedValue({
        items: [
          squareItem({ squareVariationId: 'var-1', name: 'Latte' }),
          squareItem({ squareVariationId: 'var-2', name: 'Muffin' }),
        ],
        cursor: null,
      }),
    );

    const result = await syncCatalog({ squareClient });

    expect(result.upserted).toBe(2);
    const rows = await db.select().from(catalogItems).where(eq(catalogItems.status, 'ACTIVE'));
    expect(rows).toHaveLength(2);
  });

  it('updates an existing item rather than duplicating, and advances syncedAt', async () => {
    const { syncCatalog } = await import('./sync');
    const { db, catalogItems } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const first = stubSquareClient(
      vi.fn().mockResolvedValue({
        items: [squareItem({ squareVariationId: 'var-1', priceCents: 400 })],
        cursor: null,
      }),
    );
    await syncCatalog({ squareClient: first, now: new Date('2026-01-01T00:00:00.000Z') });

    const second = stubSquareClient(
      vi.fn().mockResolvedValue({
        items: [squareItem({ squareVariationId: 'var-1', priceCents: 500 })],
        cursor: null,
      }),
    );
    const result = await syncCatalog({ squareClient: second, now: new Date('2026-01-02T00:00:00.000Z') });

    expect(result.upserted).toBe(1);
    const rows = await db.select().from(catalogItems).where(eq(catalogItems.squareVariationId, 'var-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.priceCents).toBe(500);
    expect(rows[0]?.syncedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('follows the cursor across pages', async () => {
    const { syncCatalog } = await import('./sync');

    const listCatalogItems = vi
      .fn()
      .mockResolvedValueOnce({ items: [squareItem({ squareVariationId: 'var-1' })], cursor: 'page-2' })
      .mockResolvedValueOnce({ items: [squareItem({ squareVariationId: 'var-2' })], cursor: null });

    const result = await syncCatalog({ squareClient: stubSquareClient(listCatalogItems) });

    expect(result.pages).toBe(2);
    expect(result.upserted).toBe(2);
    expect(listCatalogItems).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
  });

  it('stops at the page cap rather than looping forever', async () => {
    const { syncCatalog } = await import('./sync');

    const listCatalogItems = vi.fn().mockResolvedValue({ items: [], cursor: 'endless' });

    await expect(syncCatalog({ squareClient: stubSquareClient(listCatalogItems) })).rejects.toThrow();
  });

  it('archives items Square no longer returns, without deleting them', async () => {
    const { syncCatalog } = await import('./sync');
    const { db, catalogItems } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const seeded = stubSquareClient(
      vi.fn().mockResolvedValue({
        items: [squareItem({ squareVariationId: 'var-keep' }), squareItem({ squareVariationId: 'var-drop' })],
        cursor: null,
      }),
    );
    await syncCatalog({ squareClient: seeded });

    const omitted = stubSquareClient(
      vi.fn().mockResolvedValue({ items: [squareItem({ squareVariationId: 'var-keep' })], cursor: null }),
    );
    const result = await syncCatalog({ squareClient: omitted });

    expect(result.archived).toBe(1);
    const [dropped] = await db.select().from(catalogItems).where(eq(catalogItems.squareVariationId, 'var-drop'));
    expect(dropped).toBeDefined();
    expect(dropped?.status).toBe('ARCHIVED');
  });

  it('a failed page prevents archiving', async () => {
    const { syncCatalog } = await import('./sync');
    const { db, catalogItems } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const seeded = stubSquareClient(
      vi.fn().mockResolvedValue({ items: [squareItem({ squareVariationId: 'var-existing' })], cursor: null }),
    );
    await syncCatalog({ squareClient: seeded });

    const listCatalogItems = vi
      .fn()
      .mockResolvedValueOnce({ items: [squareItem({ squareVariationId: 'var-new' })], cursor: 'page-2' })
      .mockRejectedValueOnce(new Error('Square outage'));

    await expect(syncCatalog({ squareClient: stubSquareClient(listCatalogItems) })).rejects.toThrow(
      'Square outage',
    );

    const [existing] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.squareVariationId, 'var-existing'));
    expect(existing?.status).toBe('ACTIVE');
  });

  it('reactivates an archived item when Square returns it again', async () => {
    const { syncCatalog } = await import('./sync');
    const { db, catalogItems } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const withItem = stubSquareClient(
      vi.fn().mockResolvedValue({ items: [squareItem({ squareVariationId: 'var-cycle' })], cursor: null }),
    );
    await syncCatalog({ squareClient: withItem });

    const withoutItem = stubSquareClient(vi.fn().mockResolvedValue({ items: [], cursor: null }));
    await syncCatalog({ squareClient: withoutItem });

    const [archived] = await db.select().from(catalogItems).where(eq(catalogItems.squareVariationId, 'var-cycle'));
    expect(archived?.status).toBe('ARCHIVED');

    await syncCatalog({ squareClient: withItem });

    const [reactivated] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.squareVariationId, 'var-cycle'));
    expect(reactivated?.status).toBe('ACTIVE');
  });
});
