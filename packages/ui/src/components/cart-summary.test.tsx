import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CartSummary, type CartSummaryLine } from './cart-summary';

function line(overrides: Partial<CartSummaryLine> = {}): CartSummaryLine {
  return {
    id: 'CATALOG_ITEM:1',
    name: 'Cortado',
    quantity: 3,
    unitPriceCents: 500,
    currency: 'USD',
    lineTotalCents: 1500,
    available: true,
    ...overrides,
  };
}

describe('CartSummary', () => {
  it('renders a server-recomputed line total and subtotal', () => {
    render(<CartSummary lines={[line()]} subtotalCents={1500} currency="USD" />);

    expect(screen.getAllByText('$15.00')).toHaveLength(2); // line total + subtotal
  });

  it('lists participant names on an occurrence line', () => {
    render(
      <CartSummary
        lines={[line({ id: 'OCCURRENCE:1', name: 'Beginner Pottery', participantNames: ['Ada Lovelace', 'Grace Hopper Jr.'] })]}
        subtotalCents={1500}
        currency="USD"
      />,
    );

    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper Jr\./)).toBeInTheDocument();
  });

  it('renders an unavailable line with its reason instead of a price', () => {
    render(
      <CartSummary
        lines={[line({ available: false, unavailableReason: 'This class has sold out.' })]}
        subtotalCents={0}
        currency="USD"
      />,
    );

    expect(screen.getByText('This class has sold out.')).toBeInTheDocument();
    expect(screen.queryByText('$15.00')).not.toBeInTheDocument();
  });

  it('renders the action slot for a line', () => {
    render(
      <CartSummary
        lines={[line({ action: <button type="button">Remove</button> })]}
        subtotalCents={1500}
        currency="USD"
      />,
    );

    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('labels the subtotal as excluding tax', () => {
    render(<CartSummary lines={[line()]} subtotalCents={1500} currency="USD" />);

    expect(screen.getByText(/tax/i)).toBeInTheDocument();
  });

  it('renders an empty state for an empty cart', () => {
    render(<CartSummary lines={[]} subtotalCents={0} currency="USD" />);

    expect(screen.getByText(/cart is empty/i)).toBeInTheDocument();
  });
});
