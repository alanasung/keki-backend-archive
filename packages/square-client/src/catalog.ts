import type { SquareClient as SquareSdkClient } from 'square';
import type { SquareCatalogItem } from '@keki/contracts';

// Flattens Square's ITEM objects into one SquareCatalogItem per variation,
// carrying the parent item's name and description alongside the
// variation's own price. Returns exactly one page — WS-04 owns the paging
// loop, so a partial sync failure resumes from the last cursor rather than
// restarting the whole catalog from scratch.
export async function listCatalogItems(
  sdk: SquareSdkClient,
  input: { cursor?: string } = {},
): Promise<{ items: readonly SquareCatalogItem[]; cursor: string | null }> {
  const page = await sdk.catalog.list({
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    types: 'ITEM',
  });

  const items: SquareCatalogItem[] = [];

  for (const object of page.response.objects ?? []) {
    if (object.type !== 'ITEM' || object.itemData === undefined) {
      continue;
    }

    const { itemData } = object;
    const name = itemData.name ?? '';
    const description = itemData.description ?? null;

    for (const variationObject of itemData.variations ?? []) {
      if (variationObject.type !== 'ITEM_VARIATION' || variationObject.itemVariationData === undefined) {
        continue;
      }

      const { priceMoney } = variationObject.itemVariationData;
      const amount = priceMoney?.amount;
      const currency = priceMoney?.currency;

      // Square permits variable pricing (no fixed price on the variation).
      // Skip it rather than default to zero — a zero-priced latte on the
      // ordering page is worse than an absent one.
      if (amount === undefined || amount === null || currency === undefined) {
        continue;
      }

      items.push({
        squareCatalogObjectId: object.id,
        squareVariationId: variationObject.id,
        name,
        description,
        priceCents: Number(amount),
        currency,
      });
    }
  }

  return { items, cursor: page.response.cursor ?? null };
}
