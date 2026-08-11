'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  cartParticipantRefKey,
  cartParticipantRefSchema,
  cartSchema,
  createCatalogItemId,
  createOccurrenceId,
  type Cart,
  type CartLine,
  type CartParticipantRef,
  type HouseholdId,
} from '@keki/contracts';
import { ParticipantNotInHouseholdError } from '@keki/commerce-core';
import { listHouseholdMembers } from '@keki/customer-core';
import type { Session } from '@keki/auth';
import { authenticatedAction } from '../../actions/authenticated-action';
import { clearCart, readCart, writeCart } from './cart-cookie';
import { toBrandedParticipant } from './cart-shape';

const CART_PATH = '/cart';

const uuidSchema = z.string().uuid();

const addCafeItemSchema = z.object({
  catalogItemId: uuidSchema,
  quantity: z.number().int().min(1).max(99),
});

const addClassSeatsSchema = z
  .object({
    occurrenceId: uuidSchema,
    participants: z.array(cartParticipantRefSchema).min(1).max(10),
  })
  .superRefine((input, ctx) => {
    const keys = input.participants.map(cartParticipantRefKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate participant: the same person cannot occupy two seats.',
        path: ['participants'],
      });
    }
  });

const updateCafeQuantitySchema = z.object({
  catalogItemId: uuidSchema,
  quantity: z.number().int().min(0).max(99),
});

const removeLineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CATALOG_ITEM'), catalogItemId: uuidSchema }).strict(),
  z.object({ kind: z.literal('OCCURRENCE'), occurrenceId: uuidSchema }).strict(),
]);

// Persists a cart that has already had a delta applied. A cart with zero
// lines is cleared rather than written: cartSchema requires at least one
// line (an intentional choice — a signed-but-empty cookie is indistinguishable
// from "no cart"), so writing an empty cart would immediately fail its own
// validation on the next read.
async function persistCart(cart: Cart): Promise<void> {
  if (cart.lines.length === 0) {
    await clearCart();
    return;
  }
  // Re-validated even though every caller below builds `cart` from already
  // -validated pieces: this is the same defense-in-depth commerce-core
  // applies, at order-creation time, to a cart it did not construct itself —
  // applied here to a cart this module did construct, so a future edit to
  // one of the handlers below can't smuggle an invalid line past the cookie
  // boundary.
  cartSchema.parse(cart);
  await writeCart(cart);
}

// SC-18's usability layer: reject a submitted participant who isn't a member
// of the caller's own household before the cart even accepts the line, so
// the customer gets an immediate, comprehensible VALIDATION error instead of
// waiting for WS-05's createOrder to reject it at checkout. WS-05's check
// remains the authoritative boundary — this one exists only to give better
// feedback sooner.
async function assertParticipantsInHousehold(
  householdId: HouseholdId | null,
  participants: readonly CartParticipantRef[],
): Promise<void> {
  if (participants.length === 0) {
    return;
  }
  if (householdId === null) {
    throw new ParticipantNotInHouseholdError(participants[0]!);
  }

  const members = await listHouseholdMembers(householdId);
  const allowedKeys = new Set([
    ...members.customers.map((customer) => cartParticipantRefKey({ kind: 'CUSTOMER', customerId: customer.id })),
    ...members.children.map((child) => cartParticipantRefKey({ kind: 'CHILD', childId: child.id })),
  ]);

  for (const participant of participants) {
    if (!allowedKeys.has(cartParticipantRefKey(participant))) {
      throw new ParticipantNotInHouseholdError(participant);
    }
  }
}

export const addCafeItemAction = authenticatedAction({
  schema: addCafeItemSchema,
  async handler(input): Promise<{ cart: Cart }> {
    const catalogItemId = createCatalogItemId(input.catalogItemId);
    const cart = await readCart();
    const existingIndex = cart.lines.findIndex(
      (line) => line.kind === 'CATALOG_ITEM' && line.catalogItemId === catalogItemId,
    );

    let nextLines: CartLine[];
    if (existingIndex === -1) {
      nextLines = [...cart.lines, { kind: 'CATALOG_ITEM', catalogItemId, quantity: input.quantity }];
    } else {
      nextLines = cart.lines.map((line, index) => {
        if (index !== existingIndex || line.kind !== 'CATALOG_ITEM') {
          return line;
        }
        // Clamped rather than left to overflow cartSchema's max(99): two
        // additions that individually satisfy the 1-99 bound could
        // otherwise sum past it, which would fail persistCart's
        // cartSchema.parse and surface as an opaque INTERNAL error instead
        // of a sensible ceiling.
        return { ...line, quantity: Math.min(99, line.quantity + input.quantity) };
      });
    }

    const nextCart: Cart = { lines: nextLines };
    await persistCart(nextCart);
    revalidatePath(CART_PATH);
    return { cart: nextCart };
  },
});

export const addClassSeatsAction = authenticatedAction({
  schema: addClassSeatsSchema,
  async handler(input, session: Session): Promise<{ cart: Cart }> {
    const occurrenceId = createOccurrenceId(input.occurrenceId);
    const participants = input.participants.map(toBrandedParticipant);

    await assertParticipantsInHousehold(session.profile.householdId, participants);

    const cart = await readCart();
    const existingIndex = cart.lines.findIndex(
      (line) => line.kind === 'OCCURRENCE' && line.occurrenceId === occurrenceId,
    );
    // Replaces, never merges: merging two participant sets can silently
    // produce duplicates or exceed the per-line cap, and the picker always
    // submits the complete intended selection anyway.
    const newLine: CartLine = { kind: 'OCCURRENCE', occurrenceId, participants };
    const nextLines =
      existingIndex === -1
        ? [...cart.lines, newLine]
        : cart.lines.map((line, index) => (index === existingIndex ? newLine : line));

    const nextCart: Cart = { lines: nextLines };
    await persistCart(nextCart);
    revalidatePath(CART_PATH);
    return { cart: nextCart };
  },
});

export const updateCafeQuantityAction = authenticatedAction({
  schema: updateCafeQuantitySchema,
  async handler(input): Promise<{ cart: Cart }> {
    const catalogItemId = createCatalogItemId(input.catalogItemId);
    const cart = await readCart();

    const nextLines =
      input.quantity === 0
        ? cart.lines.filter((line) => !(line.kind === 'CATALOG_ITEM' && line.catalogItemId === catalogItemId))
        : cart.lines.map((line) =>
            line.kind === 'CATALOG_ITEM' && line.catalogItemId === catalogItemId
              ? { ...line, quantity: input.quantity }
              : line,
          );

    const nextCart: Cart = { lines: nextLines };
    await persistCart(nextCart);
    revalidatePath(CART_PATH);
    return { cart: nextCart };
  },
});

export const removeLineAction = authenticatedAction({
  schema: removeLineSchema,
  async handler(input): Promise<{ cart: Cart }> {
    const cart = await readCart();
    const nextLines = cart.lines.filter((line) => {
      if (input.kind === 'CATALOG_ITEM') {
        return !(line.kind === 'CATALOG_ITEM' && line.catalogItemId === createCatalogItemId(input.catalogItemId));
      }
      return !(line.kind === 'OCCURRENCE' && line.occurrenceId === createOccurrenceId(input.occurrenceId));
    });

    const nextCart: Cart = { lines: nextLines };
    await persistCart(nextCart);
    revalidatePath(CART_PATH);
    return { cart: nextCart };
  },
});
