import { like } from 'drizzle-orm';
import type { Tx } from '@keki/database';

const MAX_SLUG_LENGTH = 80;

// A name of only punctuation collapses to '', which would otherwise produce
// bare numeric slugs ('-2', '-3', ...) that no manager could recognize.
const FALLBACK_BASE = 'offering';

export function slugify(name: string): string {
  const collapsed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Truncating a collapsed slug can land mid-hyphen (e.g. right after a word
  // boundary at exactly 80 characters); strip it again rather than ship a
  // slug with a trailing hyphen.
  return collapsed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a slug guaranteed free at the moment of this read, appending
 * `-<n>` on a collision with an existing offering's slug.
 *
 * Must run on the caller's transaction executor: checking uniqueness on a
 * separate connection is a time-of-check-to-time-of-use bug — two concurrent
 * creates would both read the base as free and the second would fail on the
 * `offerings.slug` unique constraint. That constraint remains the real
 * guarantee; this only makes the common case produce a slug a manager can
 * act on instead of an error.
 */
export async function generateUniqueSlug(name: string, executor: Tx): Promise<string> {
  // Dynamic import so a module that merely imports `slugify` — the pure
  // half of this file — never triggers @keki/database's eager env
  // validation at import time (see
  // packages/notification-core/src/outbox.test.ts for the same pattern,
  // applied here one layer down from the test file into the source module).
  const { offerings } = await import('@keki/database');
  const base = slugify(name) || FALLBACK_BASE;

  const rows = await executor
    .select({ slug: offerings.slug })
    .from(offerings)
    .where(like(offerings.slug, `${base}%`));

  const existingSlugs = new Set(rows.map((row) => row.slug));
  if (!existingSlugs.has(base)) {
    return base;
  }

  const suffixPattern = new RegExp(`^${escapeForRegExp(base)}-([0-9]+)$`);
  let highestSuffix = 1;
  for (const slug of existingSlugs) {
    const match = suffixPattern.exec(slug);
    if (match?.[1] !== undefined) {
      highestSuffix = Math.max(highestSuffix, Number(match[1]));
    }
  }

  return `${base}-${highestSuffix + 1}`;
}
