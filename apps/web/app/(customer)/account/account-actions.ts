'use server';

import { revalidatePath } from 'next/cache';
import type { Session } from '@keki/auth';
import { addChildSchema, updateHouseholdSchema, type HouseholdId } from '@keki/contracts';
import { addChild, updateHousehold } from '@keki/customer-core';
import { authenticatedAction } from '../../actions/authenticated-action';
import { MissingHouseholdError } from '../../actions/errors';

const ACCOUNT_PATH = '/account';
const BOOK_PATH = '/book';

// The household id always comes from the session, never the payload:
// addChildSchema and updateHouseholdSchema (WS-01) have no field for it, so
// there is no household id on `input` to read even by accident. This is the
// whole security property behind SC-12 — a customer editing a stranger's
// household is the worst outcome this program can produce.
//
// `householdId` is typed `HouseholdId | null` on the profile because the
// type can't express "always set for a provisioned customer" — returning a
// handled error here rather than asserting non-null keeps a genuinely null
// value from crashing the action.
function requireHouseholdId(session: Session): HouseholdId {
  const householdId = session.profile.householdId;
  if (householdId === null) {
    throw new MissingHouseholdError();
  }
  return householdId;
}

export const addChildAction = authenticatedAction({
  schema: addChildSchema,
  async handler(input, session): Promise<void> {
    const householdId = requireHouseholdId(session);
    await addChild({
      householdId,
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: input.dateOfBirth,
    });
    revalidatePath(ACCOUNT_PATH);
    // The participant picker (book/participant-picker.tsx) lists household
    // children — a parent who just added one should find them there without
    // a hard refresh. See SC-15.
    revalidatePath(BOOK_PATH);
  },
});

export const updateHouseholdNameAction = authenticatedAction({
  schema: updateHouseholdSchema,
  async handler(input, session): Promise<void> {
    const householdId = requireHouseholdId(session);
    await updateHousehold({ householdId, name: input.name });
    revalidatePath(ACCOUNT_PATH);
  },
});
