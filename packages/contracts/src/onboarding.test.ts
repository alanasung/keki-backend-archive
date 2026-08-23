import { describe, expect, it } from 'vitest';
import { addChildSchema, completeProfileSchema, updateHouseholdSchema } from './onboarding';

const VALID_HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';

describe('completeProfileSchema', () => {
  it('accepts a first and last name', () => {
    const result = completeProfileSchema.safeParse({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    }
  });

  it('rejects a supplied email', () => {
    const result = completeProfileSchema.safeParse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a supplied cognitoSub', () => {
    const result = completeProfileSchema.safeParse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      cognitoSub: 'sub-123',
    });
    expect(result.success).toBe(false);
  });

  it('trims names and rejects a blank name', () => {
    expect(completeProfileSchema.safeParse({ firstName: '   ', lastName: 'Lovelace' }).success).toBe(
      false,
    );

    const result = completeProfileSchema.safeParse({ firstName: '  Ada ', lastName: 'Lovelace' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.firstName).toBe('Ada');
    }
  });
});

describe('addChildSchema', () => {
  const validPayload = {
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: '1995-06-15',
  };

  it('rejects a supplied householdId', () => {
    const result = addChildSchema.safeParse({ ...validPayload, householdId: VALID_HOUSEHOLD_ID });
    expect(result.success).toBe(false);
  });

  it('coerces an ISO date string', () => {
    const result = addChildSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateOfBirth).toBeInstanceOf(Date);
    }
  });

  it('refuses a future date of birth', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const result = addChildSchema.safeParse({
      ...validPayload,
      dateOfBirth: tomorrow.toISOString(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['dateOfBirth']);
    }
  });

  it("accepts today's date", () => {
    const result = addChildSchema.safeParse({
      ...validPayload,
      dateOfBirth: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('refuses a date before 1900', () => {
    const result = addChildSchema.safeParse({ ...validPayload, dateOfBirth: '1899-12-31' });
    expect(result.success).toBe(false);
  });

  it('accepts a date in 1995', () => {
    const result = addChildSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });
});

describe('updateHouseholdSchema', () => {
  it('rejects a supplied householdId', () => {
    const result = updateHouseholdSchema.safeParse({
      name: 'The Lovelaces',
      householdId: VALID_HOUSEHOLD_ID,
    });
    expect(result.success).toBe(false);
  });

  it('trims and bounds the name', () => {
    const result = updateHouseholdSchema.safeParse({ name: '  Smith ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Smith');
    }

    const tooLong = 'a'.repeat(121);
    expect(updateHouseholdSchema.safeParse({ name: tooLong }).success).toBe(false);
  });
});
