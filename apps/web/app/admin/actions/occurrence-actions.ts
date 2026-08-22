'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { cancelOccurrence, scheduleOccurrence, updateOccurrence } from '@keki/catalog-admin';
import {
  createOccurrenceId,
  scheduleOccurrenceSchema,
  updateOccurrenceSchema,
  type Occurrence,
} from '@keki/contracts';
import { authenticatedAction } from '../../actions/authenticated-action';

const uuidSchema = z.string().uuid();

const occurrenceIdSchema = z.object({ occurrenceId: uuidSchema });

const updateOccurrenceActionSchema = z.object({
  occurrenceId: uuidSchema,
  data: updateOccurrenceSchema,
});

// Scheduling, editing, or cancelling an occurrence changes what a manager
// sees on /admin/offerings and /admin/schedules, and what a customer sees on
// /book. /book is already `force-dynamic`, so revalidating it here is belt
// and braces rather than strictly required — a manager who schedules a class
// and immediately checks /book should still see it.
function revalidateCatalogSurfaces(): void {
  revalidatePath('/admin/offerings');
  revalidatePath('/admin/schedules');
  revalidatePath('/book');
}

export const scheduleOccurrenceAction = authenticatedAction({
  schema: scheduleOccurrenceSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Occurrence> {
    const occurrence = await scheduleOccurrence({
      data: input,
      // Never taken from the payload — the audit trail is only as
      // trustworthy as this.
      actorCustomerId: session.profile.customerId,
    });
    revalidateCatalogSurfaces();
    return occurrence;
  },
});

export const updateOccurrenceAction = authenticatedAction({
  schema: updateOccurrenceActionSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<{ occurrence: Occurrence; bookedSeats: number }> {
    const { after, bookedSeats } = await updateOccurrence({
      occurrenceId: createOccurrenceId(input.occurrenceId),
      data: input.data,
      actorCustomerId: session.profile.customerId,
    });
    revalidateCatalogSurfaces();
    // Always returned, not only when it exceeds capacity: the caller
    // decides what warrants a warning.
    return { occurrence: after, bookedSeats };
  },
});

export const cancelOccurrenceAction = authenticatedAction({
  schema: occurrenceIdSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Occurrence> {
    const { occurrence } = await cancelOccurrence({
      occurrenceId: createOccurrenceId(input.occurrenceId),
      actorCustomerId: session.profile.customerId,
    });
    revalidateCatalogSurfaces();
    return occurrence;
  },
});
