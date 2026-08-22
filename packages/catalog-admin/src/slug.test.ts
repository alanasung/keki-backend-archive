import { describe, expect, it } from 'vitest';
import { slugify } from './slug';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

describe('slugify', () => {
  it('lowercases and hyphenates (test 1)', () => {
    expect(slugify('Beginner Pottery')).toBe('beginner-pottery');
  });

  it('collapses punctuation runs without doubled or trailing hyphens (test 2)', () => {
    expect(slugify('Kids & Clay -- Level 1')).toBe('kids-clay-level-1');
  });

  it('truncates long names to at most 80 characters with no trailing hyphen (test 3)', () => {
    // Crafted so the 80th character lands exactly on a hyphen after
    // collapsing, exercising the post-truncation trim rather than just a
    // plain cut through alphanumerics.
    const longName = `${'x'.repeat(79)}-${'y'.repeat(120)}`;
    expect(longName).toHaveLength(200);

    const result = slugify(longName);

    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith('-')).toBe(false);
  });

  it('handles a punctuation-only name by returning an empty string (test 4)', () => {
    expect(slugify('!!!')).toBe('');
  });
});

// generateUniqueSlug queries live offerings for a collision, so it needs a
// real Postgres connection; skipped when Neon credentials are unset (e.g.
// locally) and runs in CI once the branch is provisioned. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('generateUniqueSlug', () => {
  it('returns the base slug when free (test 5)', async () => {
    const { withTransaction } = await import('@keki/database');
    const { generateUniqueSlug } = await import('./slug');

    const name = `Pottery ${crypto.randomUUID()}`;
    const slug = await withTransaction((tx) => generateUniqueSlug(name, tx));

    expect(slug).toBe(slugify(name));
  });

  it('disambiguates a collision: pottery, then pottery-2, then pottery-3 (test 6, SC-02)', async () => {
    const { db, offerings, withTransaction } = await import('@keki/database');
    const { generateUniqueSlug } = await import('./slug');

    const base = `pottery-${crypto.randomUUID()}`;
    await db.insert(offerings).values({
      slug: base,
      name: 'Existing Pottery',
      type: 'CLASS',
      durationMinutes: 60,
      defaultCapacity: 10,
      priceCents: 1000,
      status: 'DRAFT',
    });

    const second = await withTransaction((tx) => generateUniqueSlug(base, tx));
    expect(second).toBe(`${base}-2`);

    await db.insert(offerings).values({
      slug: second,
      name: 'Existing Pottery 2',
      type: 'CLASS',
      durationMinutes: 60,
      defaultCapacity: 10,
      priceCents: 1000,
      status: 'DRAFT',
    });

    const third = await withTransaction((tx) => generateUniqueSlug(base, tx));
    expect(third).toBe(`${base}-3`);
  });

  it('a punctuation-only name still produces a usable slug starting with "offering" (test 7)', async () => {
    const { withTransaction } = await import('@keki/database');
    const { generateUniqueSlug } = await import('./slug');

    const slug = await withTransaction((tx) => generateUniqueSlug('!!!', tx));

    expect(slug.startsWith('offering')).toBe(true);
    expect(slug).not.toMatch(/^-/);
  });
});
