import { describe, expect, it, vi } from 'vitest';
import { createHouseholdId } from '@keki/contracts';

// vi.mock factories are hoisted above all other top-level code, so mock state
// must be created via vi.hoisted() — see packages/auth/src/profile.test.ts
// for the same pattern.
const { insertValuesCalls, mockBatch, mockDelete, mockInsert, mockSelect, mockUpdate } = vi.hoisted(
  () => {
    const insertValuesCalls: unknown[] = [];

    function makeSelectBuilder(rows: unknown[]): PromiseLike<unknown[]> & Record<string, unknown> {
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => Promise.resolve(rows)),
        then: (
          onfulfilled?: (value: unknown[]) => unknown,
          onrejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(onfulfilled, onrejected),
      };
      return builder as unknown as PromiseLike<unknown[]> & Record<string, unknown>;
    }

    const mockSelect = vi.fn(() => makeSelectBuilder([]));

    const mockUpdate = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    }));

    const mockDelete = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));

    let insertedCustomerRow: Record<string, unknown> | undefined;

    const mockInsert = vi.fn((table: { tableName?: string }) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        if (table.tableName === 'customers') {
          insertValuesCalls.push(values);
          insertedCustomerRow = {
            id: values['id'],
            householdId: values['householdId'],
            cognitoSub: values['cognitoSub'],
            email: values['email'],
            firstName: values['firstName'],
            lastName: values['lastName'],
            phone: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          };
        }
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(insertedCustomerRow ? [insertedCustomerRow] : [])),
          })),
        };
      }),
    }));

    const mockBatch = vi.fn(async (queries: unknown[]) => Promise.all(queries));

    return { insertValuesCalls, mockBatch, mockDelete, mockInsert, mockSelect, mockUpdate };
  },
);

vi.mock('@keki/database', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    batch: mockBatch,
  },
  customers: { tableName: 'customers', cognitoSub: 'customers.cognito_sub', id: 'customers.id' },
  households: { tableName: 'households', id: 'households.id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

import { provisionCustomerProfile, startWaiverSigning } from './commands';

// addChild and updateHousehold are real commands as of WS-06 — their
// coverage lives in children.integration.test.ts against a live database,
// since both are transaction-based writes that a mocked `db` cannot
// faithfully exercise. Only startWaiverSigning is still a Phase 1 stub.
describe('deferred customer commands', () => {
  const householdId = createHouseholdId('11111111-1111-4111-8111-111111111111');

  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      'startWaiverSigning',
      () =>
        startWaiverSigning({
          waiverProvider: {
            createSigningSession: vi.fn(),
            getWaiver: vi.fn(),
            downloadDocument: vi.fn(),
          },
          householdId,
          participantName: 'Grace Lovelace',
          returnUrl: 'https://example.com/return',
        }),
    ],
  ];

  it.each(cases)('%s throws NotImplementedInPhase1', async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ kind: 'NotImplementedInPhase1' });
  });
});

describe('provisionCustomerProfile', () => {
  it('assigns the CUSTOMER role, never an elevated one', async () => {
    await provisionCustomerProfile({
      cognitoSub: 'cognito-new-1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const insertedValues = insertValuesCalls.at(-1) as Record<string, unknown> | undefined;
    expect(insertedValues?.['role']).toBe('CUSTOMER');
  });
});
