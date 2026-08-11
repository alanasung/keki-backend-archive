import 'server-only';
import { createSeatHolder } from '@keki/reservation-core';
import { createSquareClient, createStubSquareClient } from '@keki/square-client';
import type { SeatHolder, SquareClient } from '@keki/contracts';

// The single composition root for the web app: the only module permitted to
// import `@keki/square-client`'s or `@keki/reservation-core`'s concrete
// constructors (see this file's boundary test in server-clients.test.ts and
// AGENTS.md "Integrations"). Every other module receives a `SquareClient` or
// `SeatHolder` as a parameter instead of constructing its own.
const SQUARE_STUB_FLAG = 'KEKI_ALLOW_SQUARE_STUB';

let cachedSquareClient: SquareClient | undefined;
let cachedSeatHolder: SeatHolder | undefined;

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

function squareStubRequested(): boolean {
  return process.env[SQUARE_STUB_FLAG] === 'true';
}

/**
 * Returns the process-wide `SquareClient`, constructing it on first use.
 * Memoized because constructing a fresh SDK client on every request would
 * discard connection reuse and multiply cold-start cost.
 *
 * Returns `createStubSquareClient()` when `KEKI_ALLOW_SQUARE_STUB=true`, so
 * WS-12's Playwright run never contacts Square — but never in production:
 * unlike `@keki/notification-core`'s `createNoopProviders`, there is no
 * override here, because a fabricated checkout is a money-correctness
 * failure, not a degraded-but-safe fallback.
 */
export function getSquareClient(): SquareClient {
  if (cachedSquareClient === undefined) {
    if (squareStubRequested()) {
      if (isProduction()) {
        throw new Error(
          `getSquareClient: refusing to use the stub Square client with NODE_ENV=production. The stub ` +
            'returns deterministic in-memory values instead of talking to Square, so using it in ' +
            `production would silently fabricate checkouts. Unset ${SQUARE_STUB_FLAG} to use the real client.`,
        );
      }
      cachedSquareClient = createStubSquareClient();
    } else {
      cachedSquareClient = createSquareClient();
    }
  }
  return cachedSquareClient;
}

/**
 * Returns the process-wide `SeatHolder`, constructing it on first use.
 * Memoized for the same reason as `getSquareClient`.
 */
export function getSeatHolder(): SeatHolder {
  if (cachedSeatHolder === undefined) {
    cachedSeatHolder = createSeatHolder();
  }
  return cachedSeatHolder;
}
