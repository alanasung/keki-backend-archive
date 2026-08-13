import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createSquareClient } from '@keki/square-client';
import type { SquareCatalogItem } from '@keki/contracts';

// A database-free proof that the Square integration works: pulls the live
// catalog through the real `SquareClient` and renders it into a
// self-contained HTML page styled with the real `@keki/ui` theme.
//
// What is real: the Square API call, the client, the variation flattening,
// the price handling, and the theme tokens and utility classes the running
// app uses.
//
// What is NOT real: the Postgres cache that normally sits between Square and
// the page, the auth gate, the cart, and checkout. The running /book page
// reads from `catalog_items`, not from Square directly — deliberately, so
// page loads do not depend on Square being reachable. This bypasses that
// layer to give something demoable before a database exists, which is why
// the output labels itself a static render.
//
// The markup below mirrors `CatalogItemCard` and `PageShell` rather than
// importing them. Importing would be preferable, but `tsx` resolves a single
// tsconfig for the whole run and transforms those components with the
// classic JSX runtime, which they are not written for — they target the
// automatic runtime and so import no React, and every render fails with
// "React is not defined". Keeping this file JSX-free sidesteps that
// entirely. The classes are copied verbatim from those components, so the
// visual result matches; if they are restyled, re-copy them here.

const execFileAsync = promisify(execFile);
const OUT_DIR = 'demo-output';
const PAGE_CSS_ENTRY = `@import '@keki/ui/styles.css';`;

/** Mirrors `Price` — one place divides by 100, exactly as the component does. */
function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Mirrors `CatalogItemCard`. */
function renderCard(item: SquareCatalogItem): string {
  const description =
    item.description !== null && item.description !== ''
      ? `<p class="text-sm text-surface-600">${escapeHtml(item.description)}</p>`
      : '';
  return `      <article class="flex flex-col gap-2 rounded-lg border border-surface-200 bg-white p-4">
        <div class="flex items-start justify-between gap-4">
          <h4 class="text-sm font-semibold text-surface-900">${escapeHtml(item.name)}</h4>
          <span class="text-sm font-semibold text-surface-900">${formatPrice(item.priceCents, item.currency)}</span>
        </div>
        ${description}
      </article>`;
}

async function fetchAllCatalogItems(): Promise<readonly SquareCatalogItem[]> {
  const squareClient = createSquareClient();
  const items: SquareCatalogItem[] = [];
  let cursor: string | undefined;

  // Same cursor loop and hard page cap as `syncCatalog`, so an endlessly
  // paginating response cannot hang the demo.
  for (let page = 0; page < 100; page += 1) {
    const result = await squareClient.listCatalogItems(cursor !== undefined ? { cursor } : {});
    items.push(...result.items);
    if (result.cursor === null) {
      return items;
    }
    cursor = result.cursor;
  }
  throw new Error('demo-square-page: catalog pagination exceeded 100 pages.');
}

async function buildCss(): Promise<void> {
  const entry = join(OUT_DIR, 'input.css');
  await writeFile(entry, PAGE_CSS_ENTRY, 'utf8');
  // Scan this file plus the ui components so Tailwind emits the utilities
  // used here, against the real theme in packages/ui/src/styles/theme.css.
  await execFileAsync('npx', [
    'tailwindcss',
    '-i',
    entry,
    '-o',
    join(OUT_DIR, 'styles.css'),
    '--content',
    'scripts/demo-square-page.ts,packages/ui/src/components/**/*.tsx',
  ]);
}

// Stand-in catalog for `--sample`, so the page can be checked before any
// Square credentials exist. Deliberately obvious placeholders.
const SAMPLE_ITEMS: readonly SquareCatalogItem[] = [
  {
    squareCatalogObjectId: 'SAMPLE-1',
    squareVariationId: 'SAMPLE-1-REG',
    name: 'Sample Latte',
    description: 'Placeholder item — not from Square.',
    priceCents: 500,
    currency: 'USD',
  },
  {
    squareCatalogObjectId: 'SAMPLE-2',
    squareVariationId: 'SAMPLE-2-REG',
    name: 'Sample Cortado',
    description: 'Placeholder item — not from Square.',
    priceCents: 450,
    currency: 'USD',
  },
  {
    squareCatalogObjectId: 'SAMPLE-3',
    squareVariationId: 'SAMPLE-3-REG',
    name: 'Sample Croissant',
    description: null,
    priceCents: 375,
    currency: 'USD',
  },
];

function renderPage(items: readonly SquareCatalogItem[], useSample: boolean): string {
  const cards =
    items.length === 0
      ? `      <p class="text-sm text-surface-600">No priced items came back from Square. Add items with prices in the Square dashboard and re-run.</p>`
      : `      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
${items.map(renderCard).join('\n')}
      </div>`;

  const provenance = useSample
    ? 'Showing <strong>sample placeholder items</strong>, not Square data.'
    : 'Catalog data is live from the Square API.';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Keki — cafe menu</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body class="bg-surface-50 font-sans">
    <div class="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <header class="flex flex-col gap-1">
        <h1 class="text-2xl font-semibold text-surface-900">Order</h1>
        <p class="text-sm text-surface-600">Cafe menu</p>
      </header>
      <main class="flex flex-col gap-6">
${cards}
      </main>
      <footer class="border-t border-surface-200 pt-4 text-xs text-surface-500">
        Static render. ${provenance} The cart, checkout, and class booking run in the
        database-backed app.
      </footer>
    </div>
  </body>
</html>
`;
}

async function main(): Promise<void> {
  const useSample = process.argv.includes('--sample');

  console.log(
    useSample
      ? '1/3  Using sample items (--sample); Square is not contacted.'
      : '1/3  Fetching the live Square catalog…',
  );
  const items = useSample ? SAMPLE_ITEMS : await fetchAllCatalogItems();
  console.log(`     ${items.length} priced item(s)`);
  for (const item of items) {
    console.log(`       - ${item.name} — ${formatPrice(item.priceCents, item.currency)}`);
  }

  await mkdir(OUT_DIR, { recursive: true });

  console.log('2/3  Building CSS from the real theme…');
  await buildCss();

  console.log('3/3  Writing the page…');
  await writeFile(join(OUT_DIR, 'index.html'), renderPage(items, useSample), 'utf8');

  console.log(`\nDone. Open ${join(process.cwd(), OUT_DIR, 'index.html')}`);
  if (!useSample && items.length === 0) {
    console.log(
      '\n  WARNING: Square returned no priced items. Variations without a price are skipped ' +
        'by design — check the sandbox catalog has items with prices set.',
    );
  }
}

main().catch((error: unknown) => {
  console.error('demo-square-page failed:', error);
  process.exitCode = 1;
});
