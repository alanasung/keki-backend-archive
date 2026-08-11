import { listCafeItems } from '@keki/catalog-core';
import { CatalogItemCard, EmptyState } from '@keki/ui';

// Server Component: fetches its own data, renders a card per item, no
// 'use client' island and no mutation. The `CatalogItemCard` footer stays
// unused here — WS-09 wires the cart action into it.
export async function CafeMenu() {
  const items = await listCafeItems();

  if (items.length === 0) {
    return (
      <section aria-label="Cafe menu" className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-surface-900">Cafe menu</h2>
        <EmptyState
          title="No cafe items yet"
          description="The cafe menu hasn't been synced from Square yet. Check back soon."
        />
      </section>
    );
  }

  return (
    <section aria-label="Cafe menu" className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-surface-900">Cafe menu</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <CatalogItemCard
            key={item.catalogItemId}
            name={item.name}
            description={item.description}
            priceCents={item.priceCents}
            currency={item.currency}
          />
        ))}
      </div>
    </section>
  );
}
