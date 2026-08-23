// SC-17: the program's whole claim is that a tap on /staff/check-in writes a
// timestamp that /staff/occupancy reads back. Every other workstream in this
// program verifies its own surface in isolation — today's schedule, the
// check-in mutation, the occupancy query; this is the one spec that proves
// they agree about the same occurrence, signed in as the seeded
// FRONT_OF_HOUSE user (its first use anywhere in the e2e suite).
//
// Runs serially and shares a `BrowserContext`, mirroring admin-catalog.spec.ts:
// each step depends on the check-in (or undo) the previous step performed.
import { cafeDayBounds } from '@keki/staff-ops';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  E2E_STAFF_OCCURRENCE_ID,
  E2E_STAFF_OFFERING,
  E2E_STAFF_PARTICIPANT_NAMES,
  seedStaffCheckInFixtures,
} from './fixtures/seed';
import { createRoleContext } from './fixtures/session';

test.describe.configure({ mode: 'serial' });

let staffContext: BrowserContext;
let staffPage: Page;
let fixtureNow: Date;
let fixtureStartsAt: Date;

test.beforeAll(async ({ browser }) => {
  fixtureNow = new Date();
  ({ startsAt: fixtureStartsAt } = await seedStaffCheckInFixtures(fixtureNow));

  staffContext = await createRoleContext(browser, 'FRONT_OF_HOUSE');
  staffPage = await staffContext.newPage();
});

test.afterAll(async () => {
  await staffContext?.close();
});

// Both participants share one reservation, so `li:has-text(name)` alone
// matches two elements — the reservation group's own `<li>` (which contains
// both names) as well as the participant's own row. Excluding the other
// participant's name isolates the single row that's actually theirs.
function rowFor(name: string): Locator {
  const other = E2E_STAFF_PARTICIPANT_NAMES.find((candidate) => candidate !== name)!;
  return staffPage.locator('li', { hasText: name }).filter({ hasNotText: other });
}

test("the seeded occurrence starts inside the cafe's current day (test 3)", () => {
  const { start, end } = cafeDayBounds(fixtureNow);

  expect(fixtureStartsAt.getTime()).toBeGreaterThanOrEqual(start.getTime());
  expect(fixtureStartsAt.getTime()).toBeLessThan(end.getTime());
});

test('/staff/today shows the seeded class with 0 arrived (test 4 — SC-01)', async () => {
  await staffPage.goto('/staff/today');

  const card = staffPage.locator('a', { hasText: E2E_STAFF_OFFERING.name });
  await expect(card).toBeVisible();
  await expect(card).toContainText('0 / 2');
});

test('the card links to the roster, which lists both participants by name (tests 5, 6)', async () => {
  await staffPage.locator('a', { hasText: E2E_STAFF_OFFERING.name }).click();
  await staffPage.waitForURL((url) => url.pathname === '/staff/check-in');

  for (const name of E2E_STAFF_PARTICIPANT_NAMES) {
    // Not `exact: true` — both participants are children, so each name
    // renders alongside a "Child" badge inside the same paragraph.
    await expect(staffPage.getByText(name)).toBeVisible();
  }
});

test('checking in the first participant shows a time and an undo control (test 7)', async () => {
  const [firstParticipantName] = E2E_STAFF_PARTICIPANT_NAMES;
  const row = rowFor(firstParticipantName!);
  await row.getByRole('button', { name: 'Check in' }).click();

  await expect(row.getByText(/Checked in at/)).toBeVisible();
  await expect(row.getByRole('button', { name: 'Undo' })).toBeVisible();
});

test('/staff/today then shows 1 arrived (test 8 — the write actually landing)', async () => {
  await staffPage.goto('/staff/today');

  const card = staffPage.locator('a', { hasText: E2E_STAFF_OFFERING.name });
  await expect(card).toContainText('1 / 2');
});

test('/staff/occupancy counts the checked-in participant (test 9 — SC-17)', async () => {
  await staffPage.goto('/staff/occupancy');

  await expect(staffPage.locator('p.text-5xl')).toHaveText('1');
});

test('undoing the check-in drops the occupancy count back (test 10)', async () => {
  await staffPage.goto(`/staff/check-in?occurrenceId=${E2E_STAFF_OCCURRENCE_ID}`);
  const [firstParticipantName] = E2E_STAFF_PARTICIPANT_NAMES;
  const row = rowFor(firstParticipantName!);
  await row.getByRole('button', { name: 'Undo' }).click();
  await expect(row.getByRole('button', { name: 'Check in' })).toBeVisible();

  await staffPage.goto('/staff/occupancy');
  await expect(staffPage.locator('p.text-5xl')).toHaveText('0');
});

test('the roll-up survives the round trip: /staff/today shows 0 arrived again (test 11)', async () => {
  await staffPage.goto('/staff/today');

  const card = staffPage.locator('a', { hasText: E2E_STAFF_OFFERING.name });
  await expect(card).toContainText('0 / 2');
});

test('a CUSTOMER cannot reach /staff/check-in (test 12)', async ({ browser }) => {
  const customerContext = await createRoleContext(browser, 'CUSTOMER');
  const customerPage = await customerContext.newPage();
  try {
    await customerPage.goto('/staff/check-in');
    expect(new URL(customerPage.url()).pathname).toBe('/auth/unauthorized');
  } finally {
    await customerContext.close();
  }
});
