import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrderSummary, type OrderSummaryLine } from './order-summary';

function line(overrides: Partial<OrderSummaryLine> = {}): OrderSummaryLine {
  return {
    id: 'line-1',
    name: 'Cortado',
    quantity: 3,
    unitPriceCents: 500,
    currency: 'USD',
    lineTotalCents: 1500,
    ...overrides,
  };
}

describe('OrderSummary', () => {
  it('renders every line with its total and the subtotal', () => {
    render(<OrderSummary status="PAID" lines={[line()]} subtotalCents={1500} currency="USD" />);

    expect(screen.getAllByText('$15.00')).toHaveLength(2); // line total + subtotal
  });

  it('lists participant names on a class line', () => {
    render(
      <OrderSummary
        status="PAID"
        lines={[line({ id: 'line-2', name: 'Beginner Pottery', participantNames: ['Ada Lovelace', 'Grace Hopper'] })]}
        subtotalCents={1500}
        currency="USD"
      />,
    );

    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  it.each([
    ['DRAFT', 'Checkout not completed'],
    ['AWAITING_PAYMENT', 'Payment processing'],
    ['PAID', 'Paid'],
    ['CANCELLED', 'Cancelled'],
    ['EXPIRED', 'Expired'],
  ] as const)('renders the %s status label', (status, label) => {
    render(<OrderSummary status={status} lines={[]} subtotalCents={0} currency="USD" />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
