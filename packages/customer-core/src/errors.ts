import type { HouseholdId } from '@keki/contracts';

export class HouseholdNotFoundError extends Error {
  readonly kind = 'HouseholdNotFoundError';
  readonly householdId: HouseholdId;

  constructor(householdId: HouseholdId) {
    super(`No household with id "${householdId}".`);
    this.name = 'HouseholdNotFoundError';
    this.householdId = householdId;
  }
}

export class InvalidDateOfBirthError extends Error {
  readonly kind = 'InvalidDateOfBirthError';
  readonly dateOfBirth: Date;

  constructor(dateOfBirth: Date) {
    super(`Date of birth "${dateOfBirth.toISOString()}" cannot be in the future.`);
    this.name = 'InvalidDateOfBirthError';
    this.dateOfBirth = dateOfBirth;
  }
}
