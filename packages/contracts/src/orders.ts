import type { OrderStatus } from './entities';

// The order state machine, expressed as data rather than scattered
// conditionals, so every valid transition is visible in one place. The
// `Record<OrderStatus, ...>` annotation forces every status to have an
// entry — a missing one is a type error, not a silent gap. PAID is
// terminal — refunds are out of scope; modelling them now would let WS-05
// write code for a flow nobody has designed.
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAID', 'CANCELLED', 'EXPIRED'],
  PAID: [],
  CANCELLED: [],
  EXPIRED: [],
} as const;

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
