'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createOffering, transitionOffering, updateOffering } from '@keki/catalog-admin';
import {
  createOfferingId,
  createOfferingSchema,
  updateOfferingSchema,
  type CustomerId,
  type Offering,
  type OfferingStatus,
} from '@keki/contracts';
import { authenticatedAction } from '../../actions/authenticated-action';

const uuidSchema = z.string().uuid();

const offeringIdSchema = z.object({ offeringId: uuidSchema });

const updateOfferingActionSchema = z.object({
  offeringId: uuidSchema,
  data: updateOfferingSchema,
});

// Publishing, unpublishing, archiving, creating, or editing an offering all
// change what a manager sees on /admin/offerings and /admin/schedules, and
// what a customer sees on /book. /book is already `force-dynamic`, so
// revalidating it here is belt and braces rather than strictly required — a
// manager who publishes and immediately checks /book should still see it.
function revalidateCatalogSurfaces(): void {
  revalidatePath('/admin/offerings');
  revalidatePath('/admin/schedules');
  revalidatePath('/book');
}

async function transition(
  offeringId: string,
  to: OfferingStatus,
  actorCustomerId: CustomerId,
): Promise<Offering> {
  const { offering } = await transitionOffering({
    offeringId: createOfferingId(offeringId),
    to,
    actorCustomerId,
  });
  revalidateCatalogSurfaces();
  return offering;
}

export const createOfferingAction = authenticatedAction({
  schema: createOfferingSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Offering> {
    const offering = await createOffering({
      // `currency` defaults in the schema, so its parsed-input type is
      // optional even though the schema always produces a string —
      // `createOffering` takes the post-parse (default-applied) shape.
      data: { ...input, currency: input.currency ?? 'USD' },
      // Never taken from the payload — the audit trail is only as
      // trustworthy as this.
      actorCustomerId: session.profile.customerId,
    });
    revalidateCatalogSurfaces();
    return offering;
  },
});

export const updateOfferingAction = authenticatedAction({
  schema: updateOfferingActionSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Offering> {
    const { after } = await updateOffering({
      offeringId: createOfferingId(input.offeringId),
      data: input.data,
      actorCustomerId: session.profile.customerId,
    });
    revalidateCatalogSurfaces();
    return after;
  },
});

// Three separate actions rather than one taking a caller-chosen target
// status: a single setStatusAction would accept ARCHIVED from any caller who
// can reach it, resting the guard entirely on the transition table. Fixing
// the target in the action itself means an attacker cannot choose it.
export const publishOfferingAction = authenticatedAction({
  schema: offeringIdSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Offering> {
    return transition(input.offeringId, 'PUBLISHED', session.profile.customerId);
  },
});

export const unpublishOfferingAction = authenticatedAction({
  schema: offeringIdSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Offering> {
    return transition(input.offeringId, 'DRAFT', session.profile.customerId);
  },
});

export const archiveOfferingAction = authenticatedAction({
  schema: offeringIdSchema,
  requiredRole: 'MANAGER',
  async handler(input, session): Promise<Offering> {
    return transition(input.offeringId, 'ARCHIVED', session.profile.customerId);
  },
});
