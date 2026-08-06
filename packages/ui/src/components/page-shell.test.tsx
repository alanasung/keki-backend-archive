import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cn } from '../cn';
import { PageShell } from './page-shell';
import { PlaceholderPanel } from './placeholder-panel';

describe('PageShell', () => {
  it('renders exactly one h1 matching the title', () => {
    render(<PageShell title="Today">content</PageShell>);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Today');
  });

  it('renders a main landmark containing the children', () => {
    render(
      <PageShell title="Today">
        <p>booking list</p>
      </PageShell>,
    );

    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
    expect(main).toHaveTextContent('booking list');
  });

  it('omits the description when not supplied', () => {
    const { container } = render(<PageShell title="Today">content</PageShell>);

    expect(container.querySelector('p')).not.toBeInTheDocument();
  });
});

describe('PlaceholderPanel', () => {
  it('is unambiguous that the surface is not yet implemented', () => {
    render(<PlaceholderPanel title="Kiosk" />);

    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});

describe('cn', () => {
  it('resolves Tailwind conflicts last-wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});

describe('module boundaries', () => {
  it('declares no @keki/* dependency', () => {
    const filePath = fileURLToPath(new NodeURL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
    };

    expect(Object.keys(allDeps).some((name) => name.startsWith('@keki/'))).toBe(false);
  });
});
