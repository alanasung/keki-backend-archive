import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CatalogItemCard } from './catalog-item-card';

describe('CatalogItemCard', () => {
  it('renders name, description, and price', () => {
    render(
      <CatalogItemCard name="Cortado" description="Double shot, steamed milk" priceCents={450} currency="USD" />,
    );

    expect(screen.getByText('Cortado')).toBeInTheDocument();
    expect(screen.getByText('Double shot, steamed milk')).toBeInTheDocument();
    expect(screen.getByText('$4.50')).toBeInTheDocument();
  });

  it('tolerates a null description', () => {
    const { container } = render(<CatalogItemCard name="Cortado" description={null} priceCents={450} currency="USD" />);

    expect(screen.getByText('Cortado')).toBeInTheDocument();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('renders its footer slot', () => {
    render(
      <CatalogItemCard name="Cortado" priceCents={450} currency="USD" footer={<button type="button">Add to cart</button>} />,
    );

    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeInTheDocument();
  });
});
