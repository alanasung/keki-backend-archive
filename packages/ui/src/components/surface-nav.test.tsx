import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SurfaceNav, type NavItem } from './surface-nav';

const items: readonly NavItem[] = [
  { label: 'Home', href: '/customer' },
  { label: 'Book', href: '/customer/book' },
  { label: 'Account', href: '/customer/account' },
];

describe('SurfaceNav', () => {
  it('renders every supplied item', () => {
    render(<SurfaceNav surface="customer" items={items} />);

    for (const item of items) {
      const link = screen.getByRole('link', { name: item.label });
      expect(link).toHaveAttribute('href', item.href);
    }
  });

  it('marks the active item', () => {
    const target = items[1]!;
    render(<SurfaceNav surface="customer" items={items} currentPath={target.href} />);

    for (const item of items) {
      const link = screen.getByRole('link', { name: item.label });
      if (item.href === target.href) {
        expect(link).toHaveAttribute('aria-current', 'page');
      } else {
        expect(link).not.toHaveAttribute('aria-current');
      }
    }
  });

  it('renders no active item for an unmatched path', () => {
    render(<SurfaceNav surface="customer" items={items} currentPath="/nowhere" />);

    for (const item of items) {
      expect(screen.getByRole('link', { name: item.label })).not.toHaveAttribute('aria-current');
    }
  });

  it('is a server component: no client directive, no React hooks', () => {
    const filePath = fileURLToPath(new NodeURL('./surface-nav.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).not.toContain("'use client'");
    expect(source).not.toMatch(/\buse[A-Z]\w*\s*\(/);
  });
});
