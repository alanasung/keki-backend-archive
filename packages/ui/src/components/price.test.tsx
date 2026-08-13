import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Price } from './price';

describe('Price', () => {
  it('formats cents to currency', () => {
    render(<Price cents={1234} currency="USD" />);

    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  it('handles zero and large values', () => {
    const { rerender } = render(<Price cents={0} currency="USD" />);
    expect(screen.getByText('$0.00')).toBeInTheDocument();

    rerender(<Price cents={1234567} currency="USD" />);
    expect(screen.getByText('$12,345.67')).toBeInTheDocument();
  });

  it('respects a non-USD currency', () => {
    render(<Price cents={1234} currency="EUR" />);

    expect(screen.getByText('€12.34')).toBeInTheDocument();
  });
});
