import { notInArray } from 'drizzle-orm';
import { catalogItems, db } from '@keki/database';
import type { SquareCatalogItem, SquareClient } from '@keki/contracts';

// An unbounded loop against a paginated API is how a Lambda times out
// silently instead of failing loudly. 100 pages is far past any real
// catalog size for a single cafe.
const MAX_PAGES = 100;

// Square's Catalog API is deliberately off the render path (see this
// package's module doc / WS-04 spec) — this is the only place in the
// workspace that calls it, on a schedule, to keep catalog_items warm.
//
// Pages fully into memory before writing anything: if paging fails partway
// (a transient Square outage, a rate limit), nothing has been written yet,
// so the existing catalog is untouched rather than half-synced. Only after
// every page succeeds do the upserts and the archive run together as one
// Neon HTTP batch — the closest thing to a transaction the neon-http driver
// offers (see packages/customer-core/src/commands.ts for the same
// db.batch() precedent; db.transaction() throws at runtime on this driver).
export async function syncCatalog(input: {
  squareClient: SquareClient;
  now?: Date;
}): Promise<{ upserted: number; archived: number; pages: number }> {
  const now = input.now ?? new Date();
  const items: SquareCatalogItem[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const page = await input.squareClient.listCatalogItems(cursor !== undefined ? { cursor } : {});
    pages += 1;
    items.push(...page.items);

    if (page.cursor === null) {
      break;
    }
    if (pages >= MAX_PAGES) {
      throw new Error(
        `syncCatalog: Square's catalog listing did not exhaust its cursor within ${MAX_PAGES} pages; ` +
          'aborting rather than looping forever.',
      );
    }
    cursor = page.cursor;
  }

  const seenVariationIds = items.map((item) => item.squareVariationId);

  // Reactivating on upsert is deliberate: an item removed and later
  // restored in Square must come back rather than staying tombstoned.
  const upsertQueries = items.map((item) =>
    db
      .insert(catalogItems)
      .values({
        squareCatalogObjectId: item.squareCatalogObjectId,
        squareVariationId: item.squareVariationId,
        name: item.name,
        description: item.description,
        priceCents: item.priceCents,
        currency: item.currency,
        status: 'ACTIVE',
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: catalogItems.squareVariationId,
        set: {
          squareCatalogObjectId: item.squareCatalogObjectId,
          name: item.name,
          description: item.description,
          priceCents: item.priceCents,
          currency: item.currency,
          status: 'ACTIVE',
          syncedAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: catalogItems.id }),
  );

  // Never delete — order_line_items references these rows. notInArray on an
  // empty seen-set archives every currently-active row, which is correct: a
  // fully successful pass that saw nothing means the catalog is now empty.
  const archiveQuery = db
    .update(catalogItems)
    .set({ status: 'ARCHIVED', updatedAt: now })
    .where(notInArray(catalogItems.squareVariationId, seenVariationIds))
    .returning({ id: catalogItems.id });

  const [archivedRows, ...upsertedRowsPerItem] = await db.batch([archiveQuery, ...upsertQueries]);

  const upserted = upsertedRowsPerItem.reduce((total, rows) => total + rows.length, 0);
  const archived = archivedRows.length;

  console.log(
    `catalog-core: syncCatalog upserted ${upserted} item(s) and archived ${archived} item(s) across ${pages} page(s).`,
  );

  return { upserted, archived, pages };
}
