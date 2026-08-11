import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only`'s real implementation throws unconditionally outside a
// bundler that sets the `react-server` export condition (Next's build does;
// plain Node/Vitest does not) — see its package.json `exports` map. Mocked
// here so importing the composition root under test doesn't throw for a
// reason unrelated to what these tests check.
vi.mock('server-only', () => ({}));

const dir = dirname(fileURLToPath(import.meta.url));

const { mockCreateSquareClient, mockCreateStubSquareClient, mockCreateSeatHolder } = vi.hoisted(() => ({
  mockCreateSquareClient: vi.fn(() => ({ kind: 'real-square-client' as const })),
  mockCreateStubSquareClient: vi.fn(() => ({ kind: 'stub-square-client' as const })),
  mockCreateSeatHolder: vi.fn(() => ({ kind: 'seat-holder' as const })),
}));

vi.mock('@keki/square-client', () => ({
  createSquareClient: mockCreateSquareClient,
  createStubSquareClient: mockCreateStubSquareClient,
}));

vi.mock('@keki/reservation-core', () => ({
  createSeatHolder: mockCreateSeatHolder,
}));

beforeEach(() => {
  // Module-level memoization means a fresh import is the only way to get an
  // unmemoized instance per test.
  vi.resetModules();
  mockCreateSquareClient.mockClear();
  mockCreateStubSquareClient.mockClear();
  mockCreateSeatHolder.mockClear();
  // Next's global type augmentation marks `process.env.NODE_ENV` readonly
  // (apps/web/node_modules/next/types/global.d.ts), so `vi.stubEnv` — rather
  // than a direct assignment — is what setting it here has to go through.
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('KEKI_ALLOW_SQUARE_STUB', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSquareClient', () => {
  // Test 1
  it('returns a client and memoizes it across calls', async () => {
    const { getSquareClient } = await import('./server-clients');

    const first = getSquareClient();
    const second = getSquareClient();

    expect(second).toBe(first);
    expect(mockCreateSquareClient).toHaveBeenCalledTimes(1);
  });

  // Test 5
  it('refuses the stub with NODE_ENV=production', async () => {
    vi.stubEnv('KEKI_ALLOW_SQUARE_STUB', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    const { getSquareClient } = await import('./server-clients');

    expect(() => getSquareClient()).toThrow(/production/i);
    expect(mockCreateStubSquareClient).not.toHaveBeenCalled();
  });

  // Test 6
  it('returns the stub when flagged outside production', async () => {
    vi.stubEnv('KEKI_ALLOW_SQUARE_STUB', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    const { getSquareClient } = await import('./server-clients');

    const client = getSquareClient();

    expect(client).toEqual({ kind: 'stub-square-client' });
    expect(mockCreateStubSquareClient).toHaveBeenCalledTimes(1);
    expect(mockCreateSquareClient).not.toHaveBeenCalled();
  });
});

describe('getSeatHolder', () => {
  // Test 2
  it('returns a seat holder and memoizes it across calls', async () => {
    const { getSeatHolder } = await import('./server-clients');

    const first = getSeatHolder();
    const second = getSeatHolder();

    expect(second).toBe(first);
    expect(mockCreateSeatHolder).toHaveBeenCalledTimes(1);
  });
});

describe('module boundaries', () => {
  // Test 3
  it('imports server-only', () => {
    const source = readFileSync(join(dir, 'server-clients.ts'), 'utf-8');
    expect(source).toMatch(/^import 'server-only';/m);
  });

  // Test 4
  it('is the sole apps/web module importing createSquareClient, createStubSquareClient, or createSeatHolder', () => {
    const files = globSync('**/*.{ts,tsx}', {
      cwd: dir,
      exclude: (relativePath: string) => relativePath.endsWith('.test.ts') || relativePath.endsWith('.test.tsx'),
    });

    const offenders = files.filter((relativePath) => {
      if (relativePath === 'server-clients.ts') {
        return false;
      }
      const source = readFileSync(join(dir, relativePath), 'utf-8');
      return /\bcreateSquareClient\b|\bcreateStubSquareClient\b|\bcreateSeatHolder\b/.test(source);
    });

    expect(offenders).toEqual([]);
  });
});
