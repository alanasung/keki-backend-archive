import { describe, expect, it, vi } from 'vitest';
import type { SquareClient as SquareSdkClient } from 'square';
import { listCatalogItems } from './catalog';

function fakeSdk(listImpl: () => unknown) {
  const listMock = vi.fn(listImpl);
  const sdk = { catalog: { list: listMock } } as unknown as SquareSdkClient;
  return { sdk, listMock };
}

describe('listCatalogItems', () => {
  it('flattens variations, carrying the parent item name and description', async () => {
    const { sdk } = fakeSdk(() =>
      Promise.resolve({
        response: {
          objects: [
            {
              type: 'ITEM',
              id: 'item-1',
              itemData: {
                name: 'Latte',
                description: 'Espresso with steamed milk',
                variations: [
                  {
                    type: 'ITEM_VARIATION',
                    id: 'var-small',
                    itemVariationData: { priceMoney: { amount: 400n, currency: 'USD' } },
                  },
                  {
                    type: 'ITEM_VARIATION',
                    id: 'var-large',
                    itemVariationData: { priceMoney: { amount: 500n, currency: 'USD' } },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    const result = await listCatalogItems(sdk, {});

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      squareCatalogObjectId: 'item-1',
      squareVariationId: 'var-small',
      name: 'Latte',
      description: 'Espresso with steamed milk',
      priceCents: 400,
      currency: 'USD',
    });
    expect(result.items[1]).toMatchObject({
      squareCatalogObjectId: 'item-1',
      squareVariationId: 'var-large',
      name: 'Latte',
      priceCents: 500,
    });
  });

  it('skips a variation without a fixed price rather than defaulting to zero', async () => {
    const { sdk } = fakeSdk(() =>
      Promise.resolve({
        response: {
          objects: [
            {
              type: 'ITEM',
              id: 'item-1',
              itemData: {
                name: 'Coffee',
                description: null,
                variations: [
                  {
                    type: 'ITEM_VARIATION',
                    id: 'var-priced',
                    itemVariationData: { priceMoney: { amount: 300n, currency: 'USD' } },
                  },
                  {
                    type: 'ITEM_VARIATION',
                    id: 'var-variable',
                    itemVariationData: { pricingType: 'VARIABLE_PRICING' },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    const result = await listCatalogItems(sdk, {});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.squareVariationId).toBe('var-priced');
  });

  it("returns Square's cursor verbatim, or null when Square omits it", async () => {
    const withCursor = fakeSdk(() => Promise.resolve({ response: { cursor: 'next-page', objects: [] } }));
    const withoutCursor = fakeSdk(() => Promise.resolve({ response: { objects: [] } }));

    await expect(listCatalogItems(withCursor.sdk, {})).resolves.toMatchObject({ cursor: 'next-page' });
    await expect(listCatalogItems(withoutCursor.sdk, {})).resolves.toMatchObject({ cursor: null });
  });

  it('does not loop internally: calls the SDK exactly once and passes the cursor through', async () => {
    const { sdk, listMock } = fakeSdk(() => Promise.resolve({ response: { cursor: null, objects: [] } }));

    await listCatalogItems(sdk, { cursor: 'abc' });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'abc', types: 'ITEM' }));
  });
});
