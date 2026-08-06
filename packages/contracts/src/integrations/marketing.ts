import type { CustomerId } from '../ids';

export interface MarketingProvider {
  identify(input: { customerId: CustomerId; traits: Record<string, unknown> }): Promise<void>;
  track(input: {
    customerId: CustomerId;
    event: string;
    properties: Record<string, unknown>;
  }): Promise<void>;
  subscribe(input: { customerId: CustomerId; listId: string }): Promise<void>;
  /** Delivery method — mirrors the email/SMS `send` shape so dispatch is uniform. */
  send(input: {
    to: string;
    templateKey: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}
