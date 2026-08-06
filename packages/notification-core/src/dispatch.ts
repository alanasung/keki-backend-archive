import type { MarketingProvider, SmsProvider, TransactionalEmailProvider } from '@keki/contracts';
import type { NotificationOutboxEntry } from './outbox';

export interface NotificationProviders {
  readonly email: TransactionalEmailProvider;
  readonly sms: SmsProvider;
  readonly marketing: MarketingProvider;
}

// Providers arrive as a parameter — never imported or constructed here — so
// WS-11 and this package's own tests can inject doubles. The entry's id is
// always the provider idempotency key, so a redelivered/retried dispatch
// never sends the same message twice.
export async function dispatchNotification(input: {
  entry: NotificationOutboxEntry;
  providers: NotificationProviders;
}): Promise<{ providerMessageId: string }> {
  const { entry, providers } = input;
  const sendInput = {
    to: entry.recipientAddress,
    templateKey: entry.templateKey,
    payload: entry.payload,
    idempotencyKey: entry.id,
  };

  switch (entry.channel) {
    case 'EMAIL':
      return providers.email.send(sendInput);
    case 'SMS':
      return providers.sms.send(sendInput);
    case 'MARKETING':
      return providers.marketing.send(sendInput);
    default: {
      // Exhaustiveness check: adding a channel to @keki/contracts without
      // updating this switch fails the build here, rather than silently
      // dropping messages sent on the new channel.
      const unhandledChannel: never = entry.channel;
      throw new Error(`dispatchNotification: unhandled channel "${String(unhandledChannel)}".`);
    }
  }
}
