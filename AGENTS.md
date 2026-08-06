<!-- BEGIN UNIVERSAL — source: @wildorder/program-pipeline packaged default -->

# Agent Directives: Universal

These directives apply to every agent working in this repository, regardless
of provider or harness.

## Scope and depth

1. SPEC-FIRST: When a workstream spec exists under `tasks/`, read it before
   implementing. Do not invent architecture that contradicts the spec or
   `docs/vision.md`. If the spec is ambiguous, ask — do not guess.

2. ROOT CAUSE OVER SYMPTOM: Prefer the smallest diff that fully solves the
   root cause, not the smallest diff that makes symptoms disappear. When the
   proper fix is out of scope, say so explicitly and propose it as a
   follow-up instead of silently shipping a band-aid.

3. STRUCTURAL FIXES STAY IN SCOPE: If architecture is flawed, state is
   duplicated, or patterns are inconsistent inside the files the task already
   touches, fix it. Do not expand into unrelated modules without asking. On
   question-only or review-only tasks, answer — do not rewrite code unless
   asked.

## Verification

4. VERIFY BEFORE CLAIMING COMPLETION: A successful file write proves nothing
   about correctness. Before reporting a task complete, run the project's
   configured build, type-check, test, and lint commands and fix every
   resulting error. If one of those commands is not configured, state that
   explicitly instead of claiming it passed.

## Edit safety

5. READ BEFORE EDITING: Read a file before modifying it, and re-read any file
   you have not seen recently in a long session before editing it again.

6. EXHAUSTIVE RENAMES: When renaming any function, type, or variable, search
   for direct references, type-level references, string literals, dynamic
   imports, re-exports, and test files. Do not assume one search pass caught
   everything.

## Large tasks

7. WORK IN VERIFIABLE PHASES: Break multi-file work into phases that each
   pass verification on their own. In interactive sessions, pause between
   phases for review; in automated pipeline runs, complete and verify each
   phase before starting the next.

8. PARALLELIZE INDEPENDENT WORK: When the harness supports sub-agents and the
   task spans many independent files, split the work rather than degrading a
   single context; keep tightly coupled changes together.

<!-- END UNIVERSAL -->

---

## Project: keki-backend-prod

See `docs/vision.md` for the full product vision.
See `docs/programs/` for program plans and manifests.
See `tasks/{program-id}/` for workstream specs.

### Tech Stack

Next.js 15 App Router, TypeScript, pnpm workspace monorepo, SST + OpenNext on AWS, Neon Postgres, Drizzle ORM, Amazon Cognito, Tailwind CSS, Vitest, Playwright

### Product

Next.js ecommerce and scheduling platform for a cafe: class and room booking, Square integration, and customer communication, deployed on AWS.

### Conventions

These are the project's intended conventions. The repository is pre-scaffold, so
they are design decisions, not yet observed practice — the first program
establishes them.

**Module boundaries**

- `packages/*-core` are plain TypeScript libraries. They must not import from
  `apps/web`, and must not depend on Next.js, React, or any AWS SDK surface
  beyond what they genuinely need.
- Domain packages are imported _directly_ by Next.js Server Actions and by
  Lambda handlers in `functions/`. Do not introduce an internal HTTP hop
  between the app and the core.
- **Do not create a Lambda per package.** `functions/` holds exactly the four
  asynchronous workers; deployment boundaries are chosen per workload, not per
  module.
- `packages/contracts` holds shared types and schemas. When a type crosses a
  package boundary, it belongs there — not duplicated at both ends.

**Data access**

- All database access goes through `packages/database` (Drizzle). No raw SQL or
  connection handling in route handlers, Server Actions, or core packages.
- Application traffic uses Neon's **pooled** connection string; migrations use
  the **direct** connection string. These are not interchangeable.
- `play_pass_ledger` is append-only. Never update or delete ledger rows;
  correct by writing a compensating entry.

**Auth**

- Cognito owns authentication and identity. Postgres owns application profiles
  and role assignments. Never store credentials in Postgres, and never treat a
  Cognito group as the authoritative role.
- Roles are `CUSTOMER`, `FRONT_OF_HOUSE`, `MANAGER`, `ADMIN`. All `staff/` and
  `admin/` routes require authentication and an explicit role check.

**Integrations**

- Vendors are reached only through the typed interfaces — `SquareClient`,
  `WaiverProvider`, `MarketingProvider`, `TransactionalEmailProvider`,
  `SmsProvider`. Core packages depend on the interface, never on a vendor SDK.

**Testing**

- Vitest for unit and integration tests, colocated with the code under test.
- Playwright for end-to-end tests against the four route groups.
- Both run in CI.

**Delivery**

- SST + OpenNext own all AWS provisioning. No resource is created by hand in
  the console.
- Every SQS queue has a DLQ and a CloudWatch alarm on failure.
- Every workspace package (`apps/*`, `packages/*`, `functions/*`) defines all
  four scripts — `typecheck`, `lint`, `test`, `build` — because a bare
  `pnpm -r` invocation fails a package that lacks the script. Do not use
  `--if-present` to paper over a missing script; a package with nothing to
  test yet still defines a `test` script that runs its (possibly empty)
  Vitest project.
- Internal `packages/*` libraries are consumed as source, not as a build
  artifact. Each package's `main`, `types`, and `exports` point at
  `./src/index.ts` rather than a built `dist/`. Next.js transpiles the source
  directly via `transpilePackages`, and Lambda handlers in `functions/`
  bundle it with esbuild. Consequently a library's `build` script is a
  compile gate (`tsc --noEmit -p tsconfig.json`), not an emit step — do not
  invent a per-package emit pipeline.

### Dependency Versions (pin these)

Exact versions are pinned by the scaffold's `pnpm-lock.yaml`; the table below
holds the resolved versions as of that lockfile. When a version drifts,
`pnpm-lock.yaml` is the source of truth — update this table to match it, not
the other way around.

| Package                  | Version                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| next                     | 15.5.22                                                                                             |
| react / react-dom        | 19.2.8                                                                                              |
| typescript               | 5.9.3                                                                                                |
| pnpm                     | 9.15.9 (workspace, see `package.json` `packageManager`)                                             |
| sst                      | 3.19.3                                                                                               |
| @opennextjs/aws          | not a direct dependency — `sst.aws.Nextjs` bundles OpenNext internally, with no separate version to pin |
| drizzle-orm              | 0.45.2                                                                                               |
| drizzle-kit              | 0.31.10                                                                                              |
| @neondatabase/serverless | 1.1.0                                                                                                |
| tailwindcss              | 4.3.3                                                                                                |
| vitest                   | 3.2.7                                                                                                |
| @playwright/test         | 1.62.1                                                                                               |
