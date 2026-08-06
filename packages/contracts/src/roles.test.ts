import { describe, expect, it } from 'vitest';
import { ROLES, hasAtLeastRole, type Role } from './roles';

// Highest to lowest, per AGENTS.md: ADMIN > MANAGER > FRONT_OF_HOUSE > CUSTOMER
const HIERARCHY_HIGH_TO_LOW: readonly Role[] = ['ADMIN', 'MANAGER', 'FRONT_OF_HOUSE', 'CUSTOMER'];

describe('hasAtLeastRole', () => {
  it('orders every pair in the hierarchy correctly', () => {
    for (let i = 0; i < HIERARCHY_HIGH_TO_LOW.length; i++) {
      for (let j = i + 1; j < HIERARCHY_HIGH_TO_LOW.length; j++) {
        const higher = HIERARCHY_HIGH_TO_LOW[i]!;
        const lower = HIERARCHY_HIGH_TO_LOW[j]!;
        expect(hasAtLeastRole(higher, lower)).toBe(true);
        expect(hasAtLeastRole(lower, higher)).toBe(false);
      }
    }
  });

  it('is reflexive for every role', () => {
    for (const role of ROLES) {
      expect(hasAtLeastRole(role, role)).toBe(true);
    }
  });
});
