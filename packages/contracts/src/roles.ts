export const ROLES = ['CUSTOMER', 'FRONT_OF_HOUSE', 'MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = {
  CUSTOMER: 0,
  FRONT_OF_HOUSE: 1,
  MANAGER: 2,
  ADMIN: 3,
};

export function hasAtLeastRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
