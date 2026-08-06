// These are no-op providers, satisfying SC-11 (Phase 1 defines the delivery
// interfaces with no production implementation) while letting WS-11's
// worker prove the enqueue -> claim -> dispatch -> settle path end to end.
// They MUST be replaced with real Klaviyo/SES/SMS integrations before
// Phase 2 traffic — see docs/vision.md § Scope: Phase 2+. A silent no-op in
// production is a customer-communication outage that looks like success,
// which is why createNoopProviders refuses to run there without an explicit
// override.

import { randomUUID } from 'node:crypto';
import type { MarketingProvider, SmsProvider, TransactionalEmailProvider } from '@keki/contracts';
import type { NotificationProviders } from './dispatch';

function noopMessageId(): string {
  return `noop-${randomUUID()}`;
}

function assertNoopProvidersAllowed(): void {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const overrideFlag = process.env['KEKI_ALLOW_NOOP_PROVIDERS'] === 'true';

  if (isProduction && !overrideFlag) {
    throw new Error(
      'createNoopProviders: refusing to construct no-op notification providers with ' +
        'NODE_ENV=production. These providers log and return a synthetic id instead of ' +
        'delivering anything, so using them in production silently drops customer ' +
        'communications. Set KEKI_ALLOW_NOOP_PROVIDERS=true only if that is genuinely intended.',
    );
  }
}

const noopEmailProvider: TransactionalEmailProvider = {
  send(input) {
    console.log('[notification-core] noop email provider', input);
    return Promise.resolve({ providerMessageId: noopMessageId() });
  },
};

const noopSmsProvider: SmsProvider = {
  send(input) {
    console.log('[notification-core] noop sms provider', input);
    return Promise.resolve({ providerMessageId: noopMessageId() });
  },
};

const noopMarketingProvider: MarketingProvider = {
  identify(input) {
    console.log('[notification-core] noop marketing provider identify', input);
    return Promise.resolve();
  },
  track(input) {
    console.log('[notification-core] noop marketing provider track', input);
    return Promise.resolve();
  },
  subscribe(input) {
    console.log('[notification-core] noop marketing provider subscribe', input);
    return Promise.resolve();
  },
  send(input) {
    console.log('[notification-core] noop marketing provider send', input);
    return Promise.resolve({ providerMessageId: noopMessageId() });
  },
};

export function createNoopProviders(): NotificationProviders {
  assertNoopProvidersAllowed();

  return {
    email: noopEmailProvider,
    sms: noopSmsProvider,
    marketing: noopMarketingProvider,
  };
}
