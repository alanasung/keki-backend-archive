import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SquareWebhookMessage } from '@keki/contracts';
import { verifyWebhookSignature } from './verify-signature';

// Minimal local shape rather than depending on a specific `@types/aws-lambda`
// event-name export — a Lambda Function URL delivers the same payload shape
// as an API Gateway HTTP API v2 request, and this handler only touches
// headers, body, and the base64 flag.
export interface LambdaFunctionURLEvent {
  readonly headers: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
}

const SIGNATURE_HEADER = 'x-square-signature';

function getSigningKey(): string {
  const key = process.env['SQUARE_WEBHOOK_SIGNATURE_KEY'];
  if (key === undefined || key === '') {
    throw new Error('httpHandler: SQUARE_WEBHOOK_SIGNATURE_KEY is not configured.');
  }
  return key;
}

function getQueueUrl(): string {
  const url = process.env['SQUARE_WEBHOOK_QUEUE_URL'];
  if (url === undefined || url === '') {
    throw new Error('httpHandler: SQUARE_WEBHOOK_QUEUE_URL is not configured.');
  }
  return url;
}

function rawBodyOf(event: LambdaFunctionURLEvent): string {
  if (event.body === undefined) {
    return '';
  }
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function normalizeHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

const sqsClient = new SQSClient({});

// Receives untrusted input from the public internet. Verifies the signature
// against the raw body before touching anything else, then enqueues and
// returns immediately — Square retries on non-2xx, so slow synchronous
// processing here would cause duplicate deliveries. No database write, no
// payment logic: that all happens in consumer.ts, off the request path.
export async function httpHandler(event: LambdaFunctionURLEvent): Promise<{ statusCode: number }> {
  const rawBody = rawBodyOf(event);
  const signature = event.headers[SIGNATURE_HEADER];

  if (
    signature === undefined ||
    !verifyWebhookSignature({ rawBody, signature, signingKey: getSigningKey() })
  ) {
    return { statusCode: 401 };
  }

  const verifiedAt = new Date().toISOString();
  const message: SquareWebhookMessage = {
    version: 1,
    type: 'square.webhook',
    occurredAt: verifiedAt,
    payload: {
      rawBody,
      headers: normalizeHeaders(event.headers),
      verifiedAt,
    },
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: getQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );

  return { statusCode: 200 };
}
