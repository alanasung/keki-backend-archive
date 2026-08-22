import { getCustomerById, listHouseholdMembers } from '@keki/customer-core';
import { listParticipantsForReservation } from '@keki/reservation-core';
import type { AdminOccurrenceView } from '@keki/catalog-admin';
import {
  cartParticipantRefKey,
  SEAT_CONSUMING_STATUSES,
  type CartParticipantRef,
  type CustomerId,
  type HouseholdId,
  type Reservation,
  type ReservationId,
  type ReservationStatus,
} from '@keki/contracts';
import { EmptyState, StatusBadge, type StatusBadgeTone } from '@keki/ui';

// Built from the single authority in @keki/contracts rather than restated
// here, so this roster's seat total can never disagree with the capacity
// trigger, catalog-core, catalog-admin, or /admin/schedules.
const SEAT_CONSUMING: ReadonlySet<ReservationStatus> = new Set(SEAT_CONSUMING_STATUSES);

// Confirmed and checked-in rows are attendees; held rows are in-progress
// checkouts, not a booking yet, and cancelled/no-show rows are the opposite
// of booked. All render, but confirmed groups first so a glance answers "who
// is coming" without in-progress or former bookings ahead of it.
const STATUS_ORDER: readonly ReservationStatus[] = ['CONFIRMED', 'CHECKED_IN', 'HELD', 'CANCELLED', 'NO_SHOW'];

const STATUS_BADGE: Readonly<Record<ReservationStatus, { readonly label: string; readonly tone: StatusBadgeTone }>> = {
  CONFIRMED: { label: 'Confirmed', tone: 'accent' },
  CHECKED_IN: { label: 'Checked in', tone: 'accent' },
  HELD: { label: 'Held', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  NO_SHOW: { label: 'No-show', tone: 'muted' },
};

export interface RosterRow {
  readonly reservationId: ReservationId;
  readonly status: ReservationStatus;
  readonly participantNames: readonly string[];
}

export interface RosterData {
  readonly rows: readonly RosterRow[];
  readonly seatTotal: number;
}

function dedupe<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

// Resolves reservation participants to display names and groups/sums them —
// a plain async function rather than part of the rendered component, since
// React cannot resolve a nested async Server Component when rendered
// directly (as opposed to awaited by its caller, the way this page's Server
// Component awaits it before rendering the synchronous view below).
export async function resolveRoster(reservations: readonly Reservation[]): Promise<RosterData> {
  // Loaded once regardless of roster size: one query per reservation for its
  // participants is acceptable at this scale (a few dozen rows), but the
  // household-member lookup below is batched per unique household rather
  // than repeated per reservation.
  const participantsByReservationId = new Map(
    await Promise.all(
      reservations.map(
        async (reservation) => [reservation.id, await listParticipantsForReservation(reservation.id)] as const,
      ),
    ),
  );

  // Reservations only carry the booking customer's id, not their household —
  // resolve it once per unique customer, then load each unique household's
  // members exactly once (test: household members loaded once per
  // household, not per reservation).
  const uniqueCustomerIds = dedupe(reservations.map((reservation) => reservation.customerId));
  const customers = await Promise.all(uniqueCustomerIds.map((customerId) => getCustomerById(customerId)));
  const householdIdByCustomerId = new Map<CustomerId, HouseholdId>();
  for (const customer of customers) {
    if (customer !== null) {
      householdIdByCustomerId.set(customer.id, customer.householdId);
    }
  }

  const uniqueHouseholdIds = dedupe([...householdIdByCustomerId.values()]);
  const householdMembersList = await Promise.all(
    uniqueHouseholdIds.map((householdId) => listHouseholdMembers(householdId)),
  );

  // Keyed exactly as the order status page keys it — cartParticipantRefKey is
  // the one place that format is derived, and every caller reuses it rather
  // than re-deriving.
  const namesByParticipantKey = new Map<string, string>();
  for (const members of householdMembersList) {
    for (const member of members.customers) {
      namesByParticipantKey.set(
        cartParticipantRefKey({ kind: 'CUSTOMER', customerId: member.id }),
        `${member.firstName} ${member.lastName}`,
      );
    }
    for (const member of members.children) {
      namesByParticipantKey.set(
        cartParticipantRefKey({ kind: 'CHILD', childId: member.id }),
        `${member.firstName} ${member.lastName}`,
      );
    }
  }

  function namesFor(participants: readonly CartParticipantRef[]): readonly string[] {
    // A participant ref that doesn't resolve — e.g. a child removed from the
    // household after booking — is a real state, not a bug; the roster must
    // keep rendering rather than throw.
    return participants.map(
      (participant) => namesByParticipantKey.get(cartParticipantRefKey(participant)) ?? 'Unknown participant',
    );
  }

  const grouped = STATUS_ORDER.flatMap((status) => reservations.filter((reservation) => reservation.status === status));

  const rows: readonly RosterRow[] = grouped.map((reservation) => ({
    reservationId: reservation.id,
    status: reservation.status,
    participantNames: namesFor(participantsByReservationId.get(reservation.id) ?? []),
  }));

  const seatTotal = reservations
    .filter((reservation) => SEAT_CONSUMING.has(reservation.status))
    // seatCount isn't carried on the Reservation contract, but it is always
    // set to participants.length at write time (reservation-core's
    // commands.ts) — the participants already loaded above for name
    // resolution are the seat count too, with no separate query.
    .reduce((sum, reservation) => sum + (participantsByReservationId.get(reservation.id)?.length ?? 0), 0);

  return { rows, seatTotal };
}

export interface OccurrenceRosterProps {
  readonly occurrence: AdminOccurrenceView;
  readonly roster: RosterData;
}

export function OccurrenceRoster({ occurrence, roster }: OccurrenceRosterProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-surface-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-surface-900">{occurrence.offeringName}</h2>
        <p className="text-sm font-semibold text-surface-900">
          {roster.seatTotal} / {occurrence.capacity} booked
        </p>
      </div>

      {roster.rows.length === 0 ? (
        <EmptyState title="No bookings yet" description="Nobody has booked this occurrence." />
      ) : (
        <ul className="flex flex-col gap-3">
          {roster.rows.map((row) => {
            const badge = STATUS_BADGE[row.status];
            return (
              <li
                key={row.reservationId}
                className="flex items-center justify-between gap-4 rounded-lg border border-surface-200 bg-white p-4"
              >
                {/* A reservation with no participant rows renders as a blank
                    row otherwise — `[].join()` is the empty string. Distinct
                    from 'Unknown participant', which means a ref that exists
                    but no longer resolves to a household member. */}
                {row.participantNames.length === 0 ? (
                  <p className="text-sm italic text-surface-500">No participants recorded</p>
                ) : (
                  <p className="text-sm text-surface-800">{row.participantNames.join(', ')}</p>
                )}
                <StatusBadge label={badge.label} tone={badge.tone} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
