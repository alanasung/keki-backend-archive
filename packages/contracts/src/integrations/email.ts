export interface TransactionalEmailProvider {
  send(input: {
    to: string;
    templateKey: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}
