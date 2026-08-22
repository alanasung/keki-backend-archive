import type {
  OccurrenceId,
  OccurrenceStatus,
  OfferingId,
  OfferingStatus,
  OfferingType,
} from '@keki/contracts';

export class OfferingNotFoundError extends Error {
  readonly kind = 'OfferingNotFoundError';
  readonly offeringId: OfferingId;

  constructor(offeringId: OfferingId) {
    super(`No offering with id "${offeringId}".`);
    this.name = 'OfferingNotFoundError';
    this.offeringId = offeringId;
  }
}

export class InvalidOfferingTransitionError extends Error {
  readonly kind = 'InvalidOfferingTransitionError';
  readonly offeringId: OfferingId;
  readonly from: OfferingStatus;
  readonly to: OfferingStatus;

  // `from === to` also covers "edit refused on an archived offering": ARCHIVED
  // has no outgoing transitions at all (OFFERING_TRANSITIONS.ARCHIVED = []),
  // including an implicit "stay ARCHIVED" via an edit, so updateOffering
  // reuses this class rather than inventing a fourth error type.
  constructor(offeringId: OfferingId, from: OfferingStatus, to: OfferingStatus) {
    super(
      from === to
        ? `Offering "${offeringId}" is ${from} and cannot be edited.`
        : `Offering "${offeringId}" cannot move from ${from} to ${to}.`,
    );
    this.name = 'InvalidOfferingTransitionError';
    this.offeringId = offeringId;
    this.from = from;
    this.to = to;
  }
}

export class UnsupportedOfferingTypeError extends Error {
  readonly kind = 'UnsupportedOfferingTypeError';
  readonly type: OfferingType;

  constructor(type: OfferingType) {
    super(`catalog-admin only manages CLASS offerings; type "${type}" is out of scope.`);
    this.name = 'UnsupportedOfferingTypeError';
    this.type = type;
  }
}

export class OccurrenceNotFoundError extends Error {
  readonly kind = 'OccurrenceNotFoundError';
  readonly occurrenceId: OccurrenceId;

  constructor(occurrenceId: OccurrenceId) {
    super(`No occurrence with id "${occurrenceId}".`);
    this.name = 'OccurrenceNotFoundError';
    this.occurrenceId = occurrenceId;
  }
}

export class OfferingNotPublishedError extends Error {
  readonly kind = 'OfferingNotPublishedError';
  readonly offeringId: OfferingId;
  readonly status: OfferingStatus;

  // Refusing rather than scheduling invisibly: listBookableOfferings filters
  // to PUBLISHED offerings, so an occurrence against a DRAFT or ARCHIVED one
  // would never appear on /book.
  constructor(offeringId: OfferingId, status: OfferingStatus) {
    super(`Offering "${offeringId}" is ${status}, not PUBLISHED; cannot schedule an occurrence against it.`);
    this.name = 'OfferingNotPublishedError';
    this.offeringId = offeringId;
    this.status = status;
  }
}

export class OccurrenceInPastError extends Error {
  readonly kind = 'OccurrenceInPastError';
  readonly startsAt: Date;
  readonly now: Date;

  constructor(startsAt: Date, now: Date) {
    super(`Occurrence start "${startsAt.toISOString()}" is not after now ("${now.toISOString()}").`);
    this.name = 'OccurrenceInPastError';
    this.startsAt = startsAt;
    this.now = now;
  }
}

export class OverlappingOccurrenceError extends Error {
  readonly kind = 'OverlappingOccurrenceError';
  readonly conflictingOccurrenceId: OccurrenceId;
  readonly conflictingStartsAt: Date;

  constructor(conflictingOccurrenceId: OccurrenceId, conflictingStartsAt: Date) {
    super(
      `Overlaps existing occurrence "${conflictingOccurrenceId}" starting "${conflictingStartsAt.toISOString()}".`,
    );
    this.name = 'OverlappingOccurrenceError';
    this.conflictingOccurrenceId = conflictingOccurrenceId;
    this.conflictingStartsAt = conflictingStartsAt;
  }
}

export class OccurrenceHasReservationsError extends Error {
  readonly kind = 'OccurrenceHasReservationsError';
  readonly occurrenceId: OccurrenceId;
  readonly confirmedCount: number;

  // Carries the count so the UI can tell a manager *why*: "3 people are
  // booked" is actionable, "cannot cancel" is not.
  constructor(occurrenceId: OccurrenceId, confirmedCount: number) {
    super(
      `Occurrence "${occurrenceId}" has ${confirmedCount} confirmed reservation(s) and cannot be cancelled.`,
    );
    this.name = 'OccurrenceHasReservationsError';
    this.occurrenceId = occurrenceId;
    this.confirmedCount = confirmedCount;
  }
}

export class InvalidOccurrenceTransitionError extends Error {
  readonly kind = 'InvalidOccurrenceTransitionError';
  readonly occurrenceId: OccurrenceId;
  readonly from: OccurrenceStatus;
  readonly to: OccurrenceStatus;

  constructor(occurrenceId: OccurrenceId, from: OccurrenceStatus, to: OccurrenceStatus) {
    super(
      from === to
        ? `Occurrence "${occurrenceId}" is ${from} and cannot be edited.`
        : `Occurrence "${occurrenceId}" cannot move from ${from} to ${to}.`,
    );
    this.name = 'InvalidOccurrenceTransitionError';
    this.occurrenceId = occurrenceId;
    this.from = from;
    this.to = to;
  }
}
