# WS-05: UI — Tailwind preset and shared layout primitives

## Goal

Create `@keki/ui`, the shared presentation package: a Tailwind 4 configuration
shared across the workspace, the navigation component each of the four route
groups renders, and the small set of layout primitives those placeholder pages
need.

Presentational only. This package holds no domain logic, performs no data
access, and imports no other internal package.

## Traceability

- **SC-04** — Placeholder customer, kiosk, staff, and admin routes all load (supplies the shared shell those routes render).
- **SC-06** — The package compiles independently.

## Dependencies

- **WS-01** — Monorepo foundation and toolchain.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" convention; note that `ui` may not depend on any internal package
- `docs/vision.md` — sections "Target Users" and "Architecture" for the four surfaces and their route structure
- `tsconfig.base.json` — compiler options this package extends
- `package.json` (root) — the four required scripts

## Package

`packages/ui` — published internally as `@keki/ui`.

## Files Touched

- `packages/ui/package.json` (NEW)
- `packages/ui/tsconfig.json` (NEW)
- `packages/ui/src/index.ts` (NEW) — barrel
- `packages/ui/src/styles/theme.css` (NEW) — Tailwind 4 `@theme` tokens
- `packages/ui/src/components/surface-nav.tsx` (NEW) — the shared navigation
- `packages/ui/src/components/page-shell.tsx` (NEW) — page frame with heading slot
- `packages/ui/src/components/placeholder-panel.tsx` (NEW) — "not built yet" block
- `packages/ui/src/components/index.ts` (NEW) — component barrel
- `packages/ui/src/cn.ts` (NEW) — class-merge helper
- `packages/ui/src/components/surface-nav.test.tsx` (NEW)
- `packages/ui/src/components/page-shell.test.tsx` (NEW)

## Existing Interfaces to Consume

No internal packages are consumed. The package extends the WS-01 baseline and
follows the WS-01 source-export manifest convention:

```jsonc
// packages/ui/package.json — note the additional CSS export
{
  "name": "@keki/ui",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./styles.css": "./src/styles/theme.css",
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint src",
    "test": "vitest run",
    "build": "tsc --noEmit -p tsconfig.json",
  },
}
```

Because this package exports `.tsx`, `apps/web` must list `@keki/ui` in Next's
`transpilePackages`. WS-08 is responsible for that wiring; this workstream only
has to make the export surface correct.

## Implementation Steps

1. **Scaffold the package.** Dependencies: `react` and `react-dom` as
   _peer_ dependencies (not direct), plus `clsx` and `tailwind-merge`. Dev
   dependencies: `tailwindcss@4`, `vitest`, `@testing-library/react`,
   `@testing-library/jest-dom`, `jsdom`, `typescript`.

   React must be a peer dependency, not a direct one. A direct dependency risks
   a second React copy in the pnpm store, which breaks hooks at runtime in ways
   that are painful to diagnose.

2. **Set the tsconfig for React.** Extend `tsconfig.base.json` and add
   `"jsx": "react-jsx"` and `"lib": ["ES2022", "DOM", "DOM.Iterable"]`.

3. **Define the theme** in `src/styles/theme.css` using Tailwind 4's CSS-first
   configuration — an `@import "tailwindcss";` followed by an `@theme` block
   declaring the design tokens. Tailwind 4 does not use a `tailwind.config.js`
   for this; do not create one.

   Define, at minimum: a neutral surface scale, one brand accent, a
   destructive/warning color, the font family stack, and a border radius scale.
   Keep the palette small — this is a scaffold, and Phase 2 will bring real
   brand direction.

4. **Write the `cn` helper** in `src/cn.ts` combining `clsx` and
   `tailwind-merge`. Every component uses it so a caller-supplied `className`
   can override internal classes rather than colliding with them.

5. **Build `SurfaceNav`** in `src/components/surface-nav.tsx`. This is the
   shared navigation rendered by all four route groups, and it must be
   surface-aware — the customer nav and the admin nav differ in their links, not
   in their structure.

   ```tsx
   export type Surface = 'customer' | 'kiosk' | 'staff' | 'admin';

   export interface NavItem {
     readonly label: string;
     readonly href: string;
   }

   export interface SurfaceNavProps {
     readonly surface: Surface;
     readonly items: readonly NavItem[];
     readonly currentPath?: string;
     readonly className?: string;
   }
   ```

   Keep it a **server component** — no `'use client'`, no hooks, no state. The
   active item is derived from the `currentPath` prop that the caller passes,
   not from a client-side router hook. This keeps the nav renderable in every
   route group without forcing a client boundary, and WS-08 supplies
   `currentPath` from the server-side route.

   The component must not hardcode the link lists; WS-08 owns which items each
   surface shows.

6. **Build `PageShell`** in `src/components/page-shell.tsx` — a frame taking
   `title`, optional `description`, optional `actions`, and `children`. It
   renders the heading structure so every placeholder page is consistent and
   accessible: exactly one `<h1>` per page, with `<main>` landmark.

7. **Build `PlaceholderPanel`** in `src/components/placeholder-panel.tsx` — the
   explicit "this surface exists but is not implemented" block. Props: `title`
   and optional `plannedFor` note. Every placeholder page in WS-08 renders one,
   so that an unimplemented route is visibly unimplemented rather than looking
   like a broken page.

8. **Write the barrels.** `src/components/index.ts` re-exports the three
   components and their prop types; `src/index.ts` re-exports the component
   barrel and `cn`.

9. **Configure Vitest** for this package with the `jsdom` environment and a
   setup file importing `@testing-library/jest-dom`. Add
   `vitest.config.ts` to the package.

10. **Verify.** Run `pnpm --filter @keki/ui typecheck lint test build`.

## Tests

1. **`SurfaceNav` renders every supplied item** — Render with three items;
   assert three links appear with the expected `href` and label text.
2. **`SurfaceNav` marks the active item** — Render with
   `currentPath` matching the second item's `href`; assert that item carries
   `aria-current="page"` and no other item does.
3. **`SurfaceNav` renders no active item for an unmatched path** — Render with
   `currentPath="/nowhere"`; assert no element has `aria-current`.
4. **`SurfaceNav` is a server component** — Assert the source file contains no
   `'use client'` directive and imports no React hook. This guards step 5's
   constraint, which is easy to violate later.
5. **`PageShell` renders exactly one `h1`** — Render with a title; assert
   `getAllByRole('heading', { level: 1 })` has length 1 and matches the title.
6. **`PageShell` renders a `main` landmark** — Assert `getByRole('main')` is
   present and contains the children.
7. **`PageShell` omits the description when not supplied** — Render without
   `description`; assert no description element is in the DOM (not merely empty).
8. **`PlaceholderPanel` is unambiguous** — Render it; assert it exposes text
   identifying the surface as not yet implemented, so the state is legible to a
   reviewer clicking through routes.
9. **`cn` resolves Tailwind conflicts last-wins** — Assert
   `cn('p-2', 'p-4') === 'p-4'`, confirming `tailwind-merge` is wired and a
   caller `className` can genuinely override internal classes.
10. **No internal package is imported** — Assert `package.json` declares no
    `@keki/*` dependency, guarding the module-boundary rule.

## Acceptance Criteria

1. `packages/ui` compiles, lints, tests, and builds via all four scripts.
2. `react` and `react-dom` are declared as peer dependencies, not direct
   dependencies.
3. `@keki/ui` declares no `@keki/*` dependency and contains no data access,
   domain logic, or environment variable reads.
4. `SurfaceNav`, `PageShell`, and `PlaceholderPanel` are exported from the
   package root along with their prop types.
5. `SurfaceNav` contains no `'use client'` directive and no React hooks.
6. Theme tokens are defined in an `@theme` block in `src/styles/theme.css`, and
   no `tailwind.config.js` exists in the package.
7. `@keki/ui/styles.css` resolves to the theme stylesheet via the `exports` map.
8. All ten test cases pass under the `jsdom` Vitest environment.
