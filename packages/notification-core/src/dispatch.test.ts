import { describe, expect, it, vi } from 'vitest';
import { dispatchNotification } from './dispatch';
import type { NotificationOutboxEntry } from './outbox';

const baseEntry: NotificationOutboxEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  channel: 'EMAIL',
  templateKey: 'welcome',
  recipientCustomerId: null,
  recipientAddress: 'person@example.com',
  payload: { name: 'Ada' },
  status: 'CLAIMED',
  attempts: 0,
  availableAt: new Date('2026-01-01T00:00:00Z'),
  claimedAt: new Date('2026-01-01T00:00:00Z'),
  claimedBy: 'worker-1',
  sentAt: null,
  lastError: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

// Deliberately not annotated as `NotificationProviders` (or the individual
// provider interfaces): those interfaces declare `send`/`identify`/etc. with
// method shorthand, and widening these spies to that type would make
// `expect(providers.email.send)` below trip
// `@typescript-eslint/unbound-method` (it can't tell a bound `vi.fn()` from
// an unbound method reference). Structural typing still makes this object
// assignable wherever `NotificationProviders` is expected.
function makeSpyProviders() {
  const email = {
    send: vi.fn(() => Promise.resolve({ providerMessageId: 'email-message-1' })),
  };
  const sms = {
    send: vi.fn(() => Promise.resolve({ providerMessageId: 'sms-message-1' })),
  };
  const marketing = {
    identify: vi.fn(() => Promise.resolve(undefined)),
    track: vi.fn(() => Promise.resolve(undefined)),
    subscribe: vi.fn(() => Promise.resolve(undefined)),
    send: vi.fn(() => Promise.resolve({ providerMessageId: 'marketing-message-1' })),
  };
  return { email, sms, marketing };
}

describe('dispatchNotification', () => {
  it('routes an EMAIL entry to only the email provider', async () => {
    const providers = makeSpyProviders();

    await dispatchNotification({ entry: { ...baseEntry, channel: 'EMAIL' }, providers });

    expect(providers.email.send).toHaveBeenCalledTimes(1);
    expect(providers.sms.send).not.toHaveBeenCalled();
    expect(providers.marketing.send).not.toHaveBeenCalled();
  });

  it('routes an SMS entry to only the sms provider', async () => {
    const providers = makeSpyProviders();

    await dispatchNotification({ entry: { ...baseEntry, channel: 'SMS' }, providers });

    expect(providers.sms.send).toHaveBeenCalledTimes(1);
    expect(providers.email.send).not.toHaveBeenCalled();
    expect(providers.marketing.send).not.toHaveBeenCalled();
  });

  it('routes a MARKETING entry to only the marketing provider', async () => {
    const providers = makeSpyProviders();

    await dispatchNotification({ entry: { ...baseEntry, channel: 'MARKETING' }, providers });

    expect(providers.marketing.send).toHaveBeenCalledTimes(1);
    expect(providers.email.send).not.toHaveBeenCalled();
    expect(providers.sms.send).not.toHaveBeenCalled();
  });

  it('passes the entry id as the provider idempotency key', async () => {
    const providers = makeSpyProviders();

    await dispatchNotification({ entry: { ...baseEntry, channel: 'EMAIL' }, providers });

    expect(providers.email.send).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: baseEntry.id }),
    );
  });

  it('the channel switch is exhaustive', async () => {
    const providers = makeSpyProviders();
    const bogusEntry: NotificationOutboxEntry = {
      ...baseEntry,
      // @ts-expect-error — 'CARRIER_PIGEON' is not a NotificationChannel. If
      // this line stops erroring, a channel was added to @keki/contracts
      // without updating dispatchNotification's `never` branch, and
      // messages on the new channel would silently never be sent.
      channel: 'CARRIER_PIGEON',
    };

    await expect(dispatchNotification({ entry: bogusEntry, providers })).rejects.toThrow(
      /unhandled channel/,
    );
  });
});
