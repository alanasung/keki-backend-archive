import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormField } from './form-field';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('renders its label', () => {
    render(<StatusBadge label="Draft" tone="neutral" />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('applies a distinct class per tone', () => {
    const { rerender, container } = render(<StatusBadge label="Published" tone="accent" />);
    const accentClassName = container.querySelector('span')?.className;

    rerender(<StatusBadge label="Archived" tone="muted" />);
    const mutedClassName = container.querySelector('span')?.className;

    expect(accentClassName).toBeDefined();
    expect(mutedClassName).toBeDefined();
    expect(accentClassName).not.toBe(mutedClassName);
  });
});

describe('FormField', () => {
  it("associates its label with its control", () => {
    render(
      <FormField label="Name" htmlFor="offering-name">
        <input id="offering-name" />
      </FormField>,
    );

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('renders an error when given one, and is absent otherwise', () => {
    const { rerender } = render(
      <FormField label="Name" htmlFor="offering-name" error="Name is required">
        <input id="offering-name" />
      </FormField>,
    );
    expect(screen.getByText('Name is required')).toBeInTheDocument();

    rerender(
      <FormField label="Name" htmlFor="offering-name">
        <input id="offering-name" />
      </FormField>,
    );
    expect(screen.queryByText('Name is required')).not.toBeInTheDocument();
  });
});

describe('packages/ui module boundary', () => {
  // WS-06's own boundary rule: `packages/ui` is presentational and consumed
  // only by `apps/web`, so it must not depend on a domain or data package —
  // that would let `apps/web`'s Server Components leak past the app layer
  // by importing "just a UI component" that secretly queries the database.
  it('imports no data layer', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(dir, '..', '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
    };

    expect(allDeps['@keki/catalog-admin']).toBeUndefined();
    expect(allDeps['@keki/database']).toBeUndefined();
  });
});
