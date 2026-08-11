import { relations } from 'drizzle-orm';
import { staffAuditLog } from './audit';
import { catalogItems, occurrences, offerings } from './catalog';
import { paymentRecords } from './commerce';
import { waiverRecords } from './compliance';
import { orderLineItems, orders } from './orders';
import { playPassLedger, playPasses } from './passes';
import { children, customers, households } from './people';
import { reservationParticipants, reservations } from './reservations';
import { notificationOutbox } from './messaging';

export * from './enums';
export * from './people';
export * from './catalog';
export * from './reservations';
export * from './passes';
export * from './compliance';
export * from './commerce';
export * from './messaging';
export * from './audit';
export * from './orders';

export const householdsRelations = relations(households, ({ one, many }) => ({
  primaryCustomer: one(customers, {
    fields: [households.primaryCustomerId],
    references: [customers.id],
    relationName: 'household_primary_customer',
  }),
  customers: many(customers),
  children: many(children),
  reservations: many(reservations),
  playPasses: many(playPasses),
  waiverRecords: many(waiverRecords),
  paymentRecords: many(paymentRecords),
  orders: many(orders),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  household: one(households, {
    fields: [customers.householdId],
    references: [households.id],
  }),
  primaryOfHousehold: one(households, {
    fields: [customers.id],
    references: [households.primaryCustomerId],
    relationName: 'household_primary_customer',
  }),
  createdReservations: many(reservations),
  reservationParticipations: many(reservationParticipants),
  ledgerEntries: many(playPassLedger),
  waiverRecords: many(waiverRecords),
  notifications: many(notificationOutbox),
  auditLogEntries: many(staffAuditLog),
}));

export const childrenRelations = relations(children, ({ one, many }) => ({
  household: one(households, {
    fields: [children.householdId],
    references: [households.id],
  }),
  reservationParticipations: many(reservationParticipants),
  waiverRecords: many(waiverRecords),
}));

export const offeringsRelations = relations(offerings, ({ many }) => ({
  occurrences: many(occurrences),
  playPasses: many(playPasses),
}));

export const occurrencesRelations = relations(occurrences, ({ one, many }) => ({
  offering: one(offerings, {
    fields: [occurrences.offeringId],
    references: [offerings.id],
  }),
  reservations: many(reservations),
}));

export const reservationsRelations = relations(reservations, ({ one, many }) => ({
  occurrence: one(occurrences, {
    fields: [reservations.occurrenceId],
    references: [occurrences.id],
  }),
  household: one(households, {
    fields: [reservations.householdId],
    references: [households.id],
  }),
  createdBy: one(customers, {
    fields: [reservations.createdByCustomerId],
    references: [customers.id],
  }),
  participants: many(reservationParticipants),
  ledgerEntries: many(playPassLedger),
  paymentRecords: many(paymentRecords),
  orderLineItems: many(orderLineItems),
}));

export const reservationParticipantsRelations = relations(reservationParticipants, ({ one }) => ({
  reservation: one(reservations, {
    fields: [reservationParticipants.reservationId],
    references: [reservations.id],
  }),
  customer: one(customers, {
    fields: [reservationParticipants.customerId],
    references: [customers.id],
  }),
  child: one(children, {
    fields: [reservationParticipants.childId],
    references: [children.id],
  }),
  waiverRecord: one(waiverRecords, {
    fields: [reservationParticipants.waiverRecordId],
    references: [waiverRecords.id],
  }),
}));

export const playPassesRelations = relations(playPasses, ({ one, many }) => ({
  household: one(households, {
    fields: [playPasses.householdId],
    references: [households.id],
  }),
  offering: one(offerings, {
    fields: [playPasses.offeringId],
    references: [offerings.id],
  }),
  ledgerEntries: many(playPassLedger),
}));

export const playPassLedgerRelations = relations(playPassLedger, ({ one }) => ({
  playPass: one(playPasses, {
    fields: [playPassLedger.playPassId],
    references: [playPasses.id],
  }),
  reservation: one(reservations, {
    fields: [playPassLedger.reservationId],
    references: [reservations.id],
  }),
  actor: one(customers, {
    fields: [playPassLedger.actorCustomerId],
    references: [customers.id],
  }),
}));

export const waiverRecordsRelations = relations(waiverRecords, ({ one, many }) => ({
  household: one(households, {
    fields: [waiverRecords.householdId],
    references: [households.id],
  }),
  customer: one(customers, {
    fields: [waiverRecords.customerId],
    references: [customers.id],
  }),
  child: one(children, {
    fields: [waiverRecords.childId],
    references: [children.id],
  }),
  participations: many(reservationParticipants),
}));

export const paymentRecordsRelations = relations(paymentRecords, ({ one }) => ({
  household: one(households, {
    fields: [paymentRecords.householdId],
    references: [households.id],
  }),
  reservation: one(reservations, {
    fields: [paymentRecords.reservationId],
    references: [reservations.id],
  }),
}));

export const notificationOutboxRelations = relations(notificationOutbox, ({ one }) => ({
  recipient: one(customers, {
    fields: [notificationOutbox.recipientCustomerId],
    references: [customers.id],
  }),
}));

export const staffAuditLogRelations = relations(staffAuditLog, ({ one }) => ({
  actor: one(customers, {
    fields: [staffAuditLog.actorCustomerId],
    references: [customers.id],
  }),
}));

export const catalogItemsRelations = relations(catalogItems, ({ many }) => ({
  orderLineItems: many(orderLineItems),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  household: one(households, {
    fields: [orders.householdId],
    references: [households.id],
  }),
  createdBy: one(customers, {
    fields: [orders.createdByCustomerId],
    references: [customers.id],
  }),
  lineItems: many(orderLineItems),
}));

export const orderLineItemsRelations = relations(orderLineItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderLineItems.orderId],
    references: [orders.id],
  }),
  catalogItem: one(catalogItems, {
    fields: [orderLineItems.catalogItemId],
    references: [catalogItems.id],
  }),
  occurrence: one(occurrences, {
    fields: [orderLineItems.occurrenceId],
    references: [occurrences.id],
  }),
  reservation: one(reservations, {
    fields: [orderLineItems.reservationId],
    references: [reservations.id],
  }),
}));
