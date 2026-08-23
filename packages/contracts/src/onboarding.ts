import { z } from 'zod';

// ---------------------------------------------------------------------------
// Onboarding input schemas — strict parsing so an unknown key fails loudly
// rather than being silently dropped.
//
// email and cognitoSub are never inputs on completeProfileSchema: they come
// from the verified id token. Accepting either would let a caller claim an
// identity or an address (customers.email is citext unique, and is how
// staff find people) it does not control.
//
// householdId is never an input on addChildSchema or updateHouseholdSchema:
// the command takes it from the session. If it were an input, a customer
// could act on a stranger's household by editing a form field — and
// .strict() is what turns the attempt into a parse failure rather than a
// silently ignored key. See SC-12.
// ---------------------------------------------------------------------------

export const completeProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
  })
  .strict();

export type CompleteProfileInput = z.infer<typeof completeProfileSchema>;

const MIN_DATE_OF_BIRTH = new Date('1900-01-01T00:00:00.000Z');

export const addChildSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    // A date input arrives as a string from a form submission.
    dateOfBirth: z.coerce
      .date()
      // The future check is the one that matters — age decides which class
      // a child belongs in, and a future birthday makes that arithmetic
      // negative. See SC-13.
      .refine((value) => value <= new Date(), {
        message: 'Date of birth cannot be in the future.',
      })
      // Catches a mistyped year (`0202` for `2020`) that would otherwise
      // store a two-thousand-year-old child.
      .refine((value) => value >= MIN_DATE_OF_BIRTH, {
        message: 'Date of birth cannot be before 1900.',
      }),
  })
  .strict();

export type AddChildInput = z.infer<typeof addChildSchema>;

export const updateHouseholdSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export type UpdateHouseholdInput = z.infer<typeof updateHouseholdSchema>;
