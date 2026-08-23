import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CountMeter } from './count-meter';

describe('CountMeter', () => {
  // Test 15
  it('renders both the arrived and expected counts', () => {
    render(<CountMeter arrived={2} expected={5} />);

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  // Test 16
  it('handles expected === 0 without dividing by zero', () => {
    const { container } = render(<CountMeter arrived={0} expected={0} />);

    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getAllByText('0')).toHaveLength(2);
  });

  // Test 17
  it('renders zero arrived as a literal 0, not blank', () => {
    render(<CountMeter arrived={0} expected={5} />);

    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
