# WS-08: Next.js app shell and four route groups

## Goal

Create `apps/web`: a Next.js 15 App Router application with the four route
groups and every placeholder page named in the brief, wired to the shared
navigation and theme from `@keki/ui`.

Placeholder content only. No data fetching, no Server Actions with behavior, no
booking UI. Every page renders a `PlaceholderPanel` so an unimplemented surface
is visibly unimplemented.

Route protection is **not** in this workstream — WS-09 adds it. Build the routes
open, and let WS-09 close them.

## Traceability

- **SC-01** — `pnpm dev` runs the Next.js application locally.
- **SC-04** — Placeholder customer, kiosk, staff, and admin routes all load.
- **SC-06** — The app typechecks as a workspace package.

## Dependencies

- **WS-02** — Contracts (listed in `transpilePackages`; WS-05 does not create it).
- **WS-05** — UI (theme, `SurfaceNav`, `PageShell`, `PlaceholderPanel`).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" and "Delivery" conventions
- `docs/vision.md` — "Architecture" (the route tree) and "Target Users" (what each surface is for)
- `packages/ui/src/components/surface-nav.tsx` — `SurfaceNavProps`, and the fact that it is a server component taking `currentPath`
- `packages/ui/src/components/page-shell.tsx` — `PageShell` props
- `packages/ui/src/components/placeholder-panel.tsx` — `PlaceholderPanel` props
- `packages/ui/src/styles/theme.css` — the theme entry point to import
- `tsconfig.base.json`

## Package

`apps/web` — the workspace package named `web`.

## Files Touched

- `apps/web/package.json` (NEW)
- `apps/web/tsconfig.json` (NEW)
- `apps/web/next.config.ts` (NEW)
- `apps/web/postcss.config.mjs` (NEW)
- `apps/web/app/layout.tsx` (NEW) — root layout, theme import
- `apps/web/app/page.tsx` (NEW) — root redirect
- `apps/web/app/globals.css` (NEW)
- `apps/web/app/not-found.tsx` (NEW)
- `apps/web/app/error.tsx` (NEW)
- `apps/web/app/nav-config.ts` (NEW) — per-surface nav item lists
- `apps/web/app/(customer)/layout.tsx` (NEW)
- `apps/web/app/(customer)/book/page.tsx` (NEW)
- `apps/web/app/(customer)/account/page.tsx` (NEW)
- `apps/web/app/kiosk/layout.tsx` (NEW)
- `apps/web/app/kiosk/book/page.tsx` (NEW)
- `apps/web/app/kiosk/waiver/page.tsx` (NEW)
- `apps/web/app/staff/layout.tsx` (NEW)
- `apps/web/app/staff/today/page.tsx` (NEW)
- `apps/web/app/staff/check-in/page.tsx` (NEW)
- `apps/web/app/staff/occupancy/page.tsx` (NEW)
- `apps/web/app/admin/layout.tsx` (NEW)
- `apps/web/app/admin/offerings/page.tsx` (NEW)
- `apps/web/app/admin/schedules/page.tsx` (NEW)
- `apps/web/app/admin/reservations/page.tsx` (NEW)
- `apps/web/app/admin/customers/page.tsx` (NEW)
- `apps/web/app/nav-config.test.ts` (NEW)
- `apps/web/vitest.config.ts` (NEW)

## Existing Interfaces to Consume

From `@keki/ui` (WS-05). `SurfaceNav` is a **server component** — it takes
`currentPath` as a prop rather than calling a client router hook, so layouts
must pass it explicitly:

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
export declare function SurfaceNav(props: SurfaceNavProps): JSX.Element;

export interface PageShellProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}
export declare function PageShell(props: PageShellProps): JSX.Element;

export interface PlaceholderPanelProps {
  readonly title: string;
  readonly plannedFor?: string;
}
export declare function PlaceholderPanel(props: PlaceholderPanelProps): JSX.Element;
```

The theme stylesheet is exported at a subpath:

```jsonc
// packages/ui/package.json
"exports": {
  ".": "./src/index.ts",
  "./styles.css": "./src/styles/theme.css"
}
```

## Implementation Steps

1. **Scaffold the app.** Create `apps/web/package.json` with name `web`,
   `"private": true`. Dependencies: `next@15`, `react`, `react-dom`,
   `@keki/ui`, `@keki/contracts`. Both `@keki/*` entries must be declared
   workspace dependencies, not merely listed in `transpilePackages` — Next
   transpiles what it resolves, and it cannot resolve an undeclared package.
   Dev dependencies: `typescript`, `@types/react`,
   `@types/node`, `tailwindcss@4`, `@tailwindcss/postcss`, `vitest`.

   Scripts must include the four workspace-required ones plus `dev`:

   ```json
   {
     "dev": "next dev",
     "typecheck": "tsc --noEmit",
     "lint": "eslint app",
     "test": "vitest run",
     "build": "next build"
   }
   ```

   Note `build` here is a real `next build`, unlike the libraries where it is a
   typecheck gate.

2. **Configure Next** in `next.config.ts`. Set
   `transpilePackages: ['@keki/ui']` — required, because `@keki/ui` ships
   TypeScript source per the WS-01 source-export convention and Next will not
   compile a dependency otherwise. Add `@keki/contracts` to the list too, since
   WS-09 will import from it.

   Set `typedRoutes: true` so the link hrefs in `nav-config.ts` are checked
   against the actual route tree — a cheap guard against the dead nav links that
   placeholder scaffolds accumulate.

3. **Wire Tailwind 4.** Create `postcss.config.mjs` with the
   `@tailwindcss/postcss` plugin. In `app/globals.css`, import the shared theme
   first, then any app-level layer:

   ```css
   @import '@keki/ui/styles.css';
   ```

   Do not redefine theme tokens here; `@keki/ui` owns them.

4. **Build the root layout** (`app/layout.tsx`) — `<html lang="en">`, `<body>`,
   the `globals.css` import, and a `metadata` export with the title "Keki". It
   renders `children` only; each route group supplies its own chrome.

5. **Define navigation centrally** in `app/nav-config.ts`. One exported map from
   `Surface` to a readonly `NavItem[]`:

   - `customer` → Book (`/book`), Account (`/account`)
   - `kiosk` → Book (`/kiosk/book`), Waiver (`/kiosk/waiver`)
   - `staff` → Today (`/staff/today`), Check-in (`/staff/check-in`), Occupancy (`/staff/occupancy`)
   - `admin` → Offerings (`/admin/offerings`), Schedules (`/admin/schedules`), Reservations (`/admin/reservations`), Customers (`/admin/customers`)

   Keeping this in one file rather than inline per layout is what makes the
   "every nav href resolves to a real route" test possible.

   Note the `(customer)` group is a **route group** — parentheses do not appear
   in the URL, so its pages live at `/book` and `/account`, not
   `/customer/book`. The other three are real path segments.

6. **Build the four group layouts.** Each renders `SurfaceNav` with its surface
   and item list, then `children`. To supply `currentPath` without a client
   hook, read the pathname from `next/headers` in the layout (Next 15 exposes
   the request headers; use the `x-pathname` header set by the middleware WS-09
   adds, falling back to `undefined` when absent).

   Because WS-09 owns the middleware, this workstream must tolerate the header
   being missing — pass `currentPath` as optional and let the nav render with no
   active item. Do not block on WS-09.

7. **Build the eleven placeholder pages.** Each is a server component with the
   same shape:

   ```tsx
   export default function Page() {
     return (
       <PageShell title="Today" description="Staff view of today's schedule.">
         <PlaceholderPanel title="Today's schedule" plannedFor="Phase 2" />
       </PageShell>
     );
   }
   ```

   Give each a distinct, accurate title and description drawn from
   `docs/vision.md` § Target Users. Do not fabricate data, tables, or mock
   rows — a placeholder that renders fake reservations invites someone to build
   against it.

8. **Add the root page** (`app/page.tsx`) redirecting to `/book`, the customer
   entry point.

9. **Add `not-found.tsx` and `error.tsx`.** The error boundary must be a client
   component (`'use client'`) per Next's contract, and must not leak error
   details to the page in production.

10. **Configure Vitest** for the app (`vitest.config.ts`) so `pnpm -r test`
    succeeds. Only `nav-config.test.ts` runs here; page rendering is covered by
    Playwright in WS-12.

11. **Verify.** Run `pnpm dev` and load all eleven routes. Run all four scripts.

## Tests

Route rendering is verified end-to-end by Playwright in WS-12; this workstream
unit-tests the navigation configuration, which is where placeholder scaffolds
actually break.

1. **Every surface has nav items** — Assert each of the four surfaces maps to a
   non-empty item list.
2. **Every nav href resolves to a real route file** — For each item across all
   four surfaces, assert a corresponding `page.tsx` exists on disk, accounting
   for the `(customer)` route group not contributing a URL segment. This is the
   dead-link guard.
3. **Customer routes omit the group name** — Assert no customer href begins with
   `/(customer)` or `/customer`.
4. **Nav hrefs are unique** — Assert no duplicate href within a surface.
5. **The route tree matches the brief** — Assert exactly eleven `page.tsx` files
   exist under `app/`, excluding the root page, and that their paths match the
   set specified in `docs/vision.md` § Architecture.
6. **Every placeholder page renders a `PlaceholderPanel`** — Statically assert
   each of the eleven page files imports and renders `PlaceholderPanel`, so no
   surface silently looks finished.
7. **No page performs data access** — Assert no file under `apps/web/app/`
   imports `@keki/database` or any `*-core` package. Data access arrives in
   Phase 2, and a placeholder that queries is a placeholder that can break the
   build.

   Scope this assertion to `app/` specifically, not to all of `apps/web`.
   WS-12's Playwright fixtures live in `apps/web/e2e/` and must seed Postgres
   profiles directly, so a rule covering the whole package would make the e2e
   suite unimplementable.

8. **`transpilePackages` includes the source-export packages** — Assert
   `next.config.ts` lists both `@keki/ui` and `@keki/contracts`.

## Acceptance Criteria

1. `apps/web` compiles, lints, tests, and builds; `pnpm build` runs a real
   `next build` that succeeds.
2. `pnpm dev` from the repository root starts the app and serves it locally.
3. All eleven placeholder routes load with HTTP 200:
   `/book`, `/account`, `/kiosk/book`, `/kiosk/waiver`, `/staff/today`,
   `/staff/check-in`, `/staff/occupancy`, `/admin/offerings`,
   `/admin/schedules`, `/admin/reservations`, `/admin/customers`.
4. `/` redirects to `/book`.
5. Each of the four route groups renders `SurfaceNav` with its own item list
   from `app/nav-config.ts`.
6. Every placeholder page renders `PageShell` and `PlaceholderPanel` with a
   title and description specific to that surface.
7. `next.config.ts` sets `transpilePackages` for `@keki/ui` and
   `@keki/contracts`, and enables `typedRoutes`.
8. `app/globals.css` imports `@keki/ui/styles.css` and defines no theme tokens
   of its own.
9. No file under `apps/web/app/` imports `@keki/database` or any `*-core`
   package. The rule is scoped to application source; `apps/web/e2e/` is
   exempt, since WS-12's fixtures must seed the database.
10. No route is protected and no authentication check exists in this
    workstream — that is WS-09's scope.
11. The layouts tolerate a missing `x-pathname` header without throwing, since
    the middleware that sets it does not exist until WS-09.
