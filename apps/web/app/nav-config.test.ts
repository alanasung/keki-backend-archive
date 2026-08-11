import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { navConfig } from './nav-config';

const appDir = dirname(fileURLToPath(import.meta.url));

interface PageFile {
  readonly filePath: string;
  readonly urlPath: string;
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

function findPageFiles(dir: string, relSegments: readonly string[] = []): PageFile[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: PageFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      results.push(...findPageFiles(join(dir, entry.name), [...relSegments, entry.name]));
    } else if (entry.isFile() && entry.name === 'page.tsx') {
      const urlSegments = relSegments.filter((segment) => !isRouteGroup(segment));
      results.push({ filePath: join(dir, entry.name), urlPath: `/${urlSegments.join('/')}` });
    }
  }
  return results;
}

function findSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const pageFiles = findPageFiles(appDir);
// `/auth/*` pages (WS-09) are utility routes for the authorization boundary,
// not tied to any of the four nav surfaces in `navConfig` — they're asserted
// separately below rather than folded into the nav-surface route brief.
const placeholderPageFiles = pageFiles.filter(
  (page) => page.urlPath !== '/' && !page.urlPath.startsWith('/auth/'),
);
const authPageFiles = pageFiles.filter((page) => page.urlPath.startsWith('/auth/'));
const surfaces = Object.keys(navConfig) as Array<keyof typeof navConfig>;

describe('nav-config', () => {
  it('every surface has a non-empty nav item list', () => {
    for (const surface of surfaces) {
      expect(navConfig[surface].length).toBeGreaterThan(0);
    }
  });

  it('every nav href resolves to a real route file', () => {
    const knownUrlPaths = new Set(pageFiles.map((page) => page.urlPath));
    for (const surface of surfaces) {
      for (const item of navConfig[surface]) {
        expect(knownUrlPaths.has(item.href)).toBe(true);
      }
    }
  });

  it('customer routes omit the group name', () => {
    for (const item of navConfig.customer) {
      expect(item.href.startsWith('/(customer)')).toBe(false);
      expect(item.href.startsWith('/customer')).toBe(false);
    }
  });

  it('nav hrefs are unique within a surface', () => {
    for (const surface of surfaces) {
      const hrefs = navConfig[surface].map((item) => item.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });

  it('the route tree matches the brief', () => {
    const expectedUrlPaths = new Set([
      '/book',
      '/account',
      '/kiosk/book',
      '/kiosk/waiver',
      '/staff/today',
      '/staff/check-in',
      '/staff/occupancy',
      '/admin/offerings',
      '/admin/schedules',
      '/admin/reservations',
      '/admin/customers',
    ]);
    expect(placeholderPageFiles).toHaveLength(11);
    expect(new Set(placeholderPageFiles.map((page) => page.urlPath))).toEqual(expectedUrlPaths);
  });

  it('the auth surface matches WS-09s three utility routes', () => {
    const expectedAuthUrlPaths = new Set(['/auth/sign-in', '/auth/unauthorized', '/auth/complete-profile']);
    expect(authPageFiles).toHaveLength(3);
    expect(new Set(authPageFiles.map((page) => page.urlPath))).toEqual(expectedAuthUrlPaths);
  });

  it('every placeholder page renders a PlaceholderPanel', () => {
    for (const page of [...placeholderPageFiles, ...authPageFiles]) {
      const source = readFileSync(page.filePath, 'utf-8');
      expect(source).toMatch(/import\s*\{[^}]*\bPlaceholderPanel\b[^}]*\}\s*from\s*['"]@keki\/ui['"]/);
      expect(source).toMatch(/<PlaceholderPanel\b/);
    }
  });

  it('no page performs data access', () => {
    // `app/actions/**` is exempt: per AGENTS.md ("Data access"), domain
    // packages are imported directly by Server Actions, with no internal
    // HTTP hop between the app and the core. WS-07 establishes that module
    // as the sanctioned boundary; every other page stays a placeholder.
    const sourceFiles = findSourceFiles(appDir).filter(
      (filePath) => !filePath.endsWith('.test.ts') && !relative(appDir, filePath).startsWith(`actions${sep}`),
    );
    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, 'utf-8');
      expect(source).not.toMatch(/@keki\/database/);
      expect(source).not.toMatch(/@keki\/[\w-]*-core/);
    }
  });

  it('transpilePackages includes the source-export packages', () => {
    expect(nextConfig.transpilePackages).toContain('@keki/ui');
    expect(nextConfig.transpilePackages).toContain('@keki/contracts');
    expect(nextConfig.typedRoutes).toBe(true);
  });
});
