import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, occurrences, offerings } from '@keki/database';
import { syncCatalog, listCafeItems, listBookableOfferings } from '@keki/catalog-core';
import { createSquareClient } from '@keki/square-client';

// One-command demo setup: pulls the real Square catalog into the local
// `catalog_items` cache and seeds a bookable class, so `/book` renders both
// halves of the ordering page with live data.
//
// The catalog half is genuinely live — it is the same `syncCatalog` the
// scheduled worker runs in a deployed stage, against the same Square API,
// with no stubbing. The class half is seeded, because Square has no concept
// of a class occurrence: offerings and occurrences live only in Postgres and
// would normally be created through the admin surface, which is out of this
// program's scope.
//
// Requires DATABASE_URL_POOLED, DATABASE_URL_DIRECT, SQUARE_ACCESS_TOKEN and
// SQUARE_ENVIRONMENT in .env. Run `pnpm db:migrate` first.

const DEMO_OFFERING_SLUG = 'demo-pottery-class';

async function seedDemoClass(): Promise<{ name: string; startsAt: Date }> {
  const existing = await db
    .select()
    .from(offerings)
    .where(eq(offerings.slug, DEMO_OFFERING_SLUG))
    .limit(1);

  const offering =
    existing[0] ??
    (
      await db
        .insert(offerings)
        .values({
          slug: DEMO_OFFERING_SLUG,
          name: 'Beginner Pottery Class',
          description: 'A two-hour introduction to the wheel. All materials included.',
          type: 'CLASS',
          durationMinutes: 120,
          defaultCapacity: 8,
          priceCents: 4500,
          currency: 'USD',
          // PUBLISHED matters: `listBookableOfferings` filters on it, so a
          // DRAFT offering seeds fine and then renders nothing.
          status: 'PUBLISHED',
        })
        .returning()
    )[0];

  if (offering === undefined) {
    throw new Error('demo-setup: failed to create or find the demo offering.');
  }

  // Tomorrow, so it is comfortably in the future — `listBookableOfferings`
  // filters out anything starting before now, and a class seeded for "today"
  // silently disappears once the hour passes mid-demo.
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + offering.durationMinutes * 60 * 1000);

  const existingOccurrences = await db
    .select()
    .from(occurrences)
    .where(eq(occurrences.offeringId, offering.id));

  const upcoming = existingOccurrences.filter((o) => o.startsAt.getTime() > Date.now());
  if (upcoming.length === 0) {
    await db.insert(occurrences).values({
      offeringId: offering.id,
      startsAt,
      endsAt,
      status: 'SCHEDULED',
    });
  }

  return { name: offering.name, startsAt };
}

async function main(): Promise<void> {
  console.log('1/3  Syncing the Square catalog into catalog_items…');
  const squareClient = createSquareClient();
  const result = await syncCatalog({ squareClient });
  console.log(
    `     upserted ${result.upserted}, archived ${result.archived}, over ${result.pages} page(s)`,
  );

  console.log('2/3  Seeding a bookable class…');
  const demoClass = await seedDemoClass();
  console.log(`     "${demoClass.name}" on ${demoClass.startsAt.toDateString()}`);

  console.log('3/3  Reading back what /book will render…');
  const [cafeItems, bookable] = await Promise.all([listCafeItems(), listBookableOfferings()]);

  console.log(`\n  Cafe items (${cafeItems.length}):`);
  for (const item of cafeItems.slice(0, 10)) {
    console.log(`    - ${item.name} — $${(item.priceCents / 100).toFixed(2)}`);
  }
  if (cafeItems.length > 10) {
    console.log(`    … and ${cafeItems.length - 10} more`);
  }

  console.log(`\n  Bookable classes (${bookable.length}):`);
  for (const occurrence of bookable) {
    console.log(
      `    - ${occurrence.name} — $${(occurrence.priceCents / 100).toFixed(2)}, ` +
        `${occurrence.seatsRemaining}/${occurrence.capacity} seats, ` +
        `${occurrence.startsAt.toLocaleString()}`,
    );
  }

  // An empty catalog is the most likely demo failure and renders as a calm
  // empty state rather than an error, so say so plainly here instead of
  // letting it be discovered in front of an audience.
  if (cafeItems.length === 0) {
    console.log(
      '\n  WARNING: no cafe items. Either the Square account has no catalog items, ' +
        'or its items have no priced variations (the sync skips those by design). ' +
        'Add a few priced items in the Square dashboard and re-run.',
    );
  }

  console.log('\nDone. Start the app and open /book.');
}

main().catch((error: unknown) => {
  console.error('demo-setup failed:', error);
  process.exitCode = 1;
});
