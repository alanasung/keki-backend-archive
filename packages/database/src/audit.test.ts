import { describe, expect, it } from 'vitest';
import { changedFields, recordAuditEntry } from './audit';

type Row = {
  name: string;
  priceCents: number;
  notes: string | null;
  updatedAt: Date;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    name: 'A',
    priceCents: 100,
    notes: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

type RowWithDateField = {
  name: string;
  scheduledAt: Date;
  updatedAt: Date;
};

function dateRow(overrides: Partial<RowWithDateField> = {}): RowWithDateField {
  return {
    name: 'A',
    scheduledAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('changedFields', () => {
  it('returns only changed keys (test 1)', () => {
    const before = row({ priceCents: 100 });
    const after = row({ priceCents: 250 });

    const diff = changedFields(before, after);

    expect(diff).toEqual({ before: { priceCents: 100 }, after: { priceCents: 250 } });
    expect(diff.before).not.toHaveProperty('name');
    expect(diff.after).not.toHaveProperty('name');
  });

  it('excludes updatedAt (test 2)', () => {
    const before = row({ updatedAt: new Date('2026-01-01T00:00:00Z') });
    const after = row({ updatedAt: new Date('2026-01-02T00:00:00Z') });

    const diff = changedFields(before, after);

    expect(diff.before).toEqual({});
    expect(diff.after).toEqual({});
  });

  it('excludes updatedAt even alongside a real change (test 3)', () => {
    const before = row({ priceCents: 100, updatedAt: new Date('2026-01-01T00:00:00Z') });
    const after = row({ priceCents: 250, updatedAt: new Date('2026-01-02T00:00:00Z') });

    const diff = changedFields(before, after);

    expect(diff.before).toEqual({ priceCents: 100 });
    expect(diff.after).toEqual({ priceCents: 250 });
    expect(diff.before).not.toHaveProperty('updatedAt');
    expect(diff.after).not.toHaveProperty('updatedAt');
  });

  it('compares Date by value, not identity (test 4)', () => {
    const sameInstant = new Date('2026-03-01T12:00:00.000Z');
    const before = dateRow({ scheduledAt: sameInstant });
    const after = dateRow({ scheduledAt: new Date(sameInstant.getTime()) });

    const diff = changedFields(before, after);

    expect(diff.before).toEqual({});
    expect(diff.after).toEqual({});
  });

  it('reports a genuinely changed Date (test 5)', () => {
    const before = dateRow({ scheduledAt: new Date('2026-03-01T12:00:00.000Z') });
    const after = dateRow({ scheduledAt: new Date('2026-03-01T12:00:01.000Z') });

    const diff = changedFields(before, after);

    expect(diff.before).toEqual({ scheduledAt: before.scheduledAt });
    expect(diff.after).toEqual({ scheduledAt: after.scheduledAt });
  });

  it('handles a null-to-value change (test 6)', () => {
    const before = row({ notes: null });
    const after = row({ notes: 'x' });

    const diff = changedFields(before, after);

    expect(diff.before).toEqual({ notes: null });
    expect(diff.after).toEqual({ notes: 'x' });
  });

  it('an unchanged row yields two empty objects (test 7)', () => {
    const before = row({});
    const after = row({});

    const diff = changedFields(before, after);

    expect(diff.before).toEqual({});
    expect(diff.after).toEqual({});
  });
});

describe('@keki/database audit exports', () => {
  it('recordAuditEntry is exported from @keki/database (test 8)', () => {
    expect(typeof recordAuditEntry).toBe('function');
  });

  it('changedFields is exported from @keki/database (test 9)', () => {
    expect(typeof changedFields).toBe('function');
  });
});

describe('catalog-admin re-export', () => {
  // Imported by relative path, not by package specifier: packages/database
  // must declare no dependency on @keki/catalog-admin (test 12), so there is
  // no `@keki/catalog-admin` entry in this package's node_modules to resolve.
  // Held in a variable so tsc's static import graph — and this package's
  // `rootDir: "src"` — never sees a cross-package file reference; only the
  // Vitest/esbuild runtime resolves the literal path at test time.
  const catalogAdminAuditPath = '../../catalog-admin/src/audit.ts';

  async function importCatalogAdminAudit(): Promise<{
    recordAuditEntry: typeof recordAuditEntry;
    changedFields: typeof changedFields;
  }> {
    return (await import(catalogAdminAuditPath)) as {
      recordAuditEntry: typeof recordAuditEntry;
      changedFields: typeof changedFields;
    };
  }

  it('@keki/catalog-admin still exports both (test 10)', async () => {
    const catalogAdminAudit = await importCatalogAdminAudit();

    expect(typeof catalogAdminAudit.recordAuditEntry).toBe('function');
    expect(typeof catalogAdminAudit.changedFields).toBe('function');
  });

  it('the two exports are the same function object (test 11)', async () => {
    const catalogAdminAudit = await importCatalogAdminAudit();

    expect(catalogAdminAudit.recordAuditEntry).toBe(recordAuditEntry);
    expect(catalogAdminAudit.changedFields).toBe(changedFields);
  });
});

describe('dependency direction', () => {
  it('packages/database does not depend on catalog-admin or staff-ops (test 12)', async () => {
    const { readFileSync } = await import('node:fs');
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };

    expect(declared).not.toHaveProperty('@keki/catalog-admin');
    expect(declared).not.toHaveProperty('@keki/staff-ops');
  });
});
