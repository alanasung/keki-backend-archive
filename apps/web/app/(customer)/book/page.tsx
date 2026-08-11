import { PageShell } from '@keki/ui';
import { CafeMenu } from './cafe-menu';
import { ClassListing } from './class-listing';

// The class section's seat counts are live, not cached — a customer must
// never see "book" on a class that a full-route cache remembers as having
// open seats an hour after it filled. Opting the whole page out of the
// route cache keeps that read fresh on every request.
export const dynamic = 'force-dynamic';

export default async function BookPage() {
  // Two independent reads — Promise.all so the second query's latency
  // doesn't stack on top of the first's.
  const [cafeSection, classSection] = await Promise.all([CafeMenu(), ClassListing()]);

  return (
    <PageShell title="Book" description="Browse the cafe menu and book classes.">
      <div className="flex flex-col gap-10">
        {cafeSection}
        {classSection}
      </div>
    </PageShell>
  );
}
