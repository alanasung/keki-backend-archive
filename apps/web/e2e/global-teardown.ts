import { stopJwksServer } from './fixtures/jwks-server';

export default async function globalTeardown(): Promise<void> {
  await stopJwksServer();
}
