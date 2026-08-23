// Moved to @keki/database in phase-4-staff-surfaces: a single-table insert
// taking a transaction handle is data access, and staff-ops needs it too
// without depending on this package. Re-exported here so Phase 3's callers
// and its audit suite keep working unchanged.
export { recordAuditEntry, changedFields } from '@keki/database';
