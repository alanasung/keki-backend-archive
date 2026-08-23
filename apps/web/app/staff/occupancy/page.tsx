import { CAFE_TIME_ZONE } from '@keki/contracts';
import { getCurrentOccupancy } from '@keki/staff-ops';
import { EmptyState, PageShell } from '@keki/ui';
import { OccupancyLines } from './occupancy-lines';
import { RefreshButton } from './refresh-button';

// A cached occupancy count is worse than none — it reads as certain even
// after the building has emptied out. This route is never served stale.
export const dynamic = 'force-dynamic';

const asOfFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export default async function StaffOccupancyPage() {
  const snapshot = await getCurrentOccupancy();

  return (
    <PageShell title="Occupancy" description="Who is currently in the building." actions={<RefreshButton />}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <p className="text-5xl font-bold text-surface-900">{snapshot.totalHeadcount}</p>
          <p className="text-sm text-surface-600">
            {snapshot.totalHeadcount === 1 ? 'person' : 'people'} currently in the building
          </p>
        </div>

        <p className="text-sm text-surface-600">
          As of{' '}
          <time dateTime={snapshot.asOf.toISOString()}>{asOfFormatter.format(snapshot.asOf)}</time>. This counts
          participants checked in to classes that have not yet ended. There is no check-out, so someone who left
          early still counts until their class ends.
        </p>

        {snapshot.lines.length === 0 ? (
          <EmptyState
            title="Nobody is currently in the building"
            description="No classes are in progress right now."
          />
        ) : (
          <OccupancyLines lines={snapshot.lines} />
        )}
      </div>
    </PageShell>
  );
}
