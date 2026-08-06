import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));

const { mockRequireKioskDevice, mockHeadersGet } = vi.hoisted(() => ({
  mockRequireKioskDevice: vi.fn(),
  mockHeadersGet: vi.fn(),
}));

vi.mock('../auth/guards', () => ({ requireKioskDevice: mockRequireKioskDevice }));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve({ get: mockHeadersGet })),
}));

const { default: KioskLayout } = await import('./layout');

describe('KioskLayout', () => {
  beforeEach(() => {
    mockRequireKioskDevice.mockReset();
    mockHeadersGet.mockReset();
  });

  // Case 15: the cookie-matching logic itself (absent / wrong / matching
  // device token) is exhaustively covered in app/auth/guards.test.ts. What
  // belongs here is that the layout actually calls requireKioskDevice and
  // propagates its outcome rather than rendering regardless.
  it('propagates the redirect when the device is not authorized', async () => {
    mockRequireKioskDevice.mockRejectedValue(new Error('REDIRECT:/auth/sign-in'));

    await expect(KioskLayout({ children: null })).rejects.toThrow('REDIRECT:/auth/sign-in');
  });

  it('renders when the device is authorized', async () => {
    mockRequireKioskDevice.mockResolvedValue(undefined);
    mockHeadersGet.mockReturnValue('/kiosk/book');

    const element = await KioskLayout({ children: null });

    expect(element).toBeTruthy();
    expect(mockRequireKioskDevice).toHaveBeenCalledTimes(1);
  });

  // Case 16
  it('never resolves a user profile or calls requireRole', () => {
    const source = readFileSync(join(dir, 'layout.tsx'), 'utf-8');
    expect(source).not.toMatch(/requireRole/);
    expect(source).not.toMatch(/findProfileByCognitoSub/);
  });
});
