import { notFound } from 'next/navigation';
import { createOccurrenceId, type OccurrenceId, type ReservationId, type ReservationStatus } from '@keki/contracts';
import {
  listOccurrenceRoster,
  listTodaysOccurrences,
  type RosterParticipantView,
  type StaffOccurrenceView,
} from '@keki/staff-ops';
import { EmptyState, PageShell } from '@keki/ui';
import { OccurrencePicker } from './occurrence-picker';
import { ReservationNoShowControl, RosterRow } from './roster-row';

// A staff member pulls this up mid-queue — it must show who has actually
// arrived right now, not a stale route-cache snapshot.
export const dynamic = 'force-dynamic';

interface StaffCheckInPageProps {
  readonly searchParams: Promise<{ readonly occurrenceId?: string }>;
}

interface ReservationGroup {
  readonly reservationId: ReservationId;
  readonly reservationStatus: ReservationStatus;
  readonly participants: readonly RosterParticipantView[];
}

// Not exported: Next.js's typed-routes generator rejects any page.tsx
// export beyond its known set (default, metadata, dynamic, ...). Exercised
// through the page's default-selection test instead.
//
// The in-progress occurrence is preferred over landing on a chooser when
// exactly one class is running, which is almost certainly what was wanted.
// Falls back to the next occurrence starting today, then to the earliest of
// today's occurrences if every one has already ended.
function selectDefaultOccurrence(
  occurrences: readonly StaffOccurrenceView[],
  now: Date,
): StaffOccurrenceView | undefined {
  const inProgress = occurrences.find(
    (occurrence) => occurrence.startsAt.getTime() <= now.getTime() && now.getTime() < occurrence.endsAt.getTime(),
  );
  if (inProgress !== undefined) {
    return inProgress;
  }

  const upcoming = occurrences
    .filter((occurrence) => occurrence.startsAt.getTime() > now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return upcoming[0] ?? [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
}

// The no-show control's home is the reservation, not the participant — see
// roster-row.tsx's ReservationNoShowControl.
function groupByReservation(roster: readonly RosterParticipantView[]): readonly ReservationGroup[] {
  const groups = new Map<ReservationId, ReservationGroup>();
  for (const participant of roster) {
    const existing = groups.get(participant.reservationId);
    if (existing === undefined) {
      groups.set(participant.reservationId, {
        reservationId: participant.reservationId,
        reservationStatus: participant.reservationStatus,
        participants: [participant],
      });
    } else {
      groups.set(participant.reservationId, { ...existing, participants: [...existing.participants, participant] });
    }
  }
  return [...groups.values()];
}

export default async function StaffCheckInPage({ searchParams }: StaffCheckInPageProps) {
  const params = await searchParams;
  const now = new Date();
  const occurrences = await listTodaysOccurrences({ now });
  // Re-sorted rather than trusted from read order, mirroring /staff/today.
  const sorted = [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  if (sorted.length === 0) {
    return (
      <PageShell title="Check-in" description="Check guests in for today's sessions.">
        <OccurrencePicker occurrences={[]} selectedOccurrenceId={null} />
      </PageShell>
    );
  }

  let occurrenceId: OccurrenceId;
  if (params.occurrenceId !== undefined) {
    try {
      occurrenceId = createOccurrenceId(params.occurrenceId);
    } catch {
      notFound();
    }
  } else {
    const defaultOccurrence = selectDefaultOccurrence(sorted, now);
    if (defaultOccurrence === undefined) {
      notFound();
    }
    occurrenceId = defaultOccurrence.occurrenceId;
  }

  const selected = sorted.find((occurrence) => occurrence.occurrenceId === occurrenceId);
  if (selected === undefined) {
    notFound();
  }

  const roster = await listOccurrenceRoster(selected.occurrenceId);
  const groups = groupByReservation(roster);

  return (
    <PageShell title="Check-in" description="Check guests in for today's sessions.">
      <div className="flex flex-col gap-6 lg:flex-row">
        <OccurrencePicker occurrences={sorted} selectedOccurrenceId={selected.occurrenceId} />
        <div className="flex-1">
          {groups.length === 0 ? (
            <EmptyState title="Nobody is booked" description="Nobody is booked for this class." />
          ) : (
            <ul className="flex flex-col gap-4">
              {groups.map((group) => {
                const anyCheckedIn = group.participants.some((participant) => participant.checkedInAt !== null);
                return (
                  <li
                    key={group.reservationId}
                    className="flex flex-col gap-3 rounded-lg border border-surface-200 bg-white p-4"
                  >
                    <ul className="flex flex-col gap-2">
                      {group.participants.map((participant) => (
                        <RosterRow
                          key={participant.participantId}
                          participantId={participant.participantId}
                          displayName={participant.displayName}
                          isChild={participant.isChild}
                          checkedInAt={participant.checkedInAt}
                        />
                      ))}
                    </ul>
                    <div className="flex justify-end">
                      <ReservationNoShowControl
                        reservationId={group.reservationId}
                        reservationStatus={group.reservationStatus}
                        anyCheckedIn={anyCheckedIn}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </PageShell>
  );
}
