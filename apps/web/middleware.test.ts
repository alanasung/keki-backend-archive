import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, middleware } from './middleware';

const dir = dirname(fileURLToPath(import.meta.url));

function requestFor(path: string, options: { readonly cookie?: string } = {}): NextRequest {
  const headers = options.cookie !== undefined ? { cookie: options.cookie } : {};
  return new NextRequest(new URL(path, 'http://localhost:3000'), { headers });
}

describe('middleware', () => {
  // Case 11
  it('sets x-pathname on the forwarded request for a matched path', () => {
    const response = middleware(requestFor('/staff/today', { cookie: 'keki_id_token=valid-token' }));

    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/staff/today');
    expect(response.headers.get('location')).toBeNull();
  });

  // Case 12
  it('redirects a cookieless /staff request to sign-in', () => {
    const response = middleware(requestFor('/staff/today'));

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location ?? '');
    expect(redirectUrl.pathname).toBe('/auth/sign-in');
    expect(redirectUrl.searchParams.get('next')).toBe('/staff/today');
  });

  it('redirects a cookieless /admin request to sign-in', () => {
    const response = middleware(requestFor('/admin/offerings'));

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get('location') ?? '');
    expect(redirectUrl.pathname).toBe('/auth/sign-in');
    expect(redirectUrl.searchParams.get('next')).toBe('/admin/offerings');
  });

  // Case 13
  it('does not gate the public customer surface', () => {
    const response = middleware(requestFor('/book'));

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/book');
  });

  it('does not gate the sign-in page itself, avoiding a redirect loop', () => {
    const response = middleware(requestFor('/auth/sign-in'));

    expect(response.headers.get('location')).toBeNull();
  });

  // Case 14
  it('imports no database or domain-core package (Edge runtime cannot reach Postgres)', () => {
    const source = readFileSync(join(dir, 'middleware.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"]@keki\/database['"]/);
    expect(source).not.toMatch(/from\s+['"]@keki\/[\w-]*-core['"]/);
  });

  it('the matcher excludes _next, static assets, and /auth', () => {
    expect(config.matcher).toEqual(
      expect.arrayContaining([expect.stringContaining('_next')]),
    );
    for (const pattern of config.matcher) {
      expect(pattern).toContain('auth');
    }
  });
});
