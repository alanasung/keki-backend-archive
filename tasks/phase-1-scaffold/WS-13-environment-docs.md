# WS-13: Environment setup documentation

## Goal

Write the repository README and supporting environment documentation so a new
engineer can go from a fresh clone to a running application, applied migrations,
a linked AWS stage, and a passing test suite — without asking anyone.

This is the last workstream in the program and the one that satisfies SC-09.

## Traceability

- **SC-09** — Environment setup is documented in the repository README.
- **SC-01, SC-02, SC-03** — Documents the exact commands that satisfy each, so the criteria are reproducible rather than folkloric.

## Dependencies

- **WS-10** — SST infrastructure (the resources and secrets being documented).
- **WS-12** — Test harness and CI (the commands being documented).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — the conventions a new contributor must follow
- `docs/vision.md` — "Scope: Phase 1" success criteria and the architecture summary
- `docs/testing.md` — the test layers written by WS-12; the README links to it rather than restating it
- `package.json` (root) — every script being documented
- `packages/database/src/env.ts` — `DATABASE_URL_POOLED`, `DATABASE_URL_DIRECT`, and the swap guard
- `packages/auth/src/env.ts` — the Cognito variables
- `infra/secrets.ts` — the seven `sst.Secret` names
- `sst.config.ts` — stage configuration

## Package

Repository root (`.`).

## Files Touched

- `README.md` (NEW)
- `.env.example` (NEW) — every variable, with placeholder values
- `docs/environment.md` (NEW) — variable reference and secret provisioning
- `docs/architecture.md` (NEW) — short orientation for new contributors
- `CONTRIBUTING.md` (NEW) — workflow and conventions summary
- `AGENTS.md` (MODIFY) — fill the dependency version table from the lockfile

## Existing Interfaces to Consume

The environment variables to document, gathered from the packages that validate
them at startup. WS-03 additionally rejects the case where the two database URLs
are swapped, which the documentation must explain rather than leave as a
surprise:

```ts
// packages/database/src/env.ts (WS-03)
DATABASE_URL_POOLED; // Neon pooled endpoint; host MUST contain "-pooler"
DATABASE_URL_DIRECT; // Neon direct endpoint; host MUST NOT contain "-pooler"

// packages/auth/src/env.ts (WS-04)
COGNITO_USER_POOL_ID;
COGNITO_CLIENT_ID;
AWS_REGION;

// packages/auth/src/env.ts (WS-04) — optional, test stages only
COGNITO_ISSUER; // rejected when NODE_ENV=production
COGNITO_JWKS_URI; // rejected when NODE_ENV=production

// apps/web (WS-09)
KIOSK_DEVICE_TOKEN;

// functions/square-webhook (WS-11) — function environment, not the web app
SQUARE_WEBHOOK_SIGNATURE_KEY;

// functions/notification-worker (WS-11) — non-production stages only
KEKI_ALLOW_NOOP_PROVIDERS;
```

The seven secrets declared in `infra/secrets.ts` (WS-10):

```
NeonPooledUrl, NeonDirectUrl, SquareAccessToken,
SquareWebhookSignatureKey, KlaviyoApiKey,
WaiverProviderApiKey, KioskDeviceToken
```

## Implementation Steps

1. **Write the README** with a strict first-run path. Order the sections so a
   reader can follow them top to bottom without jumping:

   1. What Keki is — three sentences, linking to `docs/vision.md`.
   2. Prerequisites — Node from `.nvmrc`, pnpm 9, an AWS account with
      credentials configured, a Neon project.
   3. Clone and install.
   4. Environment setup — copy `.env.example`, fill it, link to
      `docs/environment.md`.
   5. Database — run migrations.
   6. Run locally — `pnpm dev`.
   7. Link to AWS — `pnpm sst:dev`.
   8. Run tests — link to `docs/testing.md`.
   9. Repository layout — the monorepo map.
   10. Where to go next — `AGENTS.md`, `docs/vision.md`, `CONTRIBUTING.md`.

   Every command must be copy-pasteable and must have been executed by the
   author. Do not document a command that was not run — a README that has never
   been followed is the most common way a scaffold's setup instructions rot
   before anyone else reads them.

2. **Write `.env.example`** listing every variable from _Existing Interfaces to
   Consume_, each with a comment saying what it is and where to obtain it, and a
   placeholder value that is obviously a placeholder.

   **Commit no real credentials.** Use values like
   `postgresql://user:password@ep-example-pooler.region.aws.neon.tech/keki`.
   Verify `.env` (without `.example`) is gitignored before writing this file.

3. **Document the pooled/direct split prominently** in both the README and
   `docs/environment.md`. State plainly:

   - `DATABASE_URL_POOLED` — pooled endpoint, host contains `-pooler`, used by
     all application traffic.
   - `DATABASE_URL_DIRECT` — direct endpoint, used only by migrations.
   - They are not interchangeable, and the application refuses to start if they
     are swapped.

   Include the error message WS-03's guard produces, so someone who hits it can
   search for it and land on the explanation.

4. **Write `docs/environment.md`** as the full reference: a table of every
   variable (name, required, consumed by, how to obtain). Distinguish the three
   scopes explicitly — variables linked into the **web app**, variables linked
   into **individual functions** (`SQUARE_WEBHOOK_SIGNATURE_KEY`,
   `KEKI_ALLOW_NOOP_PROVIDERS`), and the **test-only** overrides
   (`COGNITO_ISSUER`, `COGNITO_JWKS_URI`) that the application refuses to accept
   in production. Then a section on
   provisioning the seven SST secrets with the concrete
   `pnpm sst secret set <Name> <value> --stage <stage>` invocations, then a
   section on stage conventions (`dev` personal stages, `production` protected).

5. **Write `docs/architecture.md`** as a short orientation — the package graph,
   why the cores are plain libraries, why there is no Lambda per package, and
   the Cognito/Postgres split. Two pages at most; link to `docs/vision.md` for
   depth rather than duplicating it, since duplicated architecture docs diverge.

6. **Write `CONTRIBUTING.md`** covering: the four verify commands and the
   requirement that every package define all four; the source-export convention
   for internal packages; the module-boundary rules; that migrations are
   generated by drizzle-kit and hand-edited only for the two constraints WS-03
   documents; and that `AGENTS.md` is the authoritative conventions document.

7. **Fill the `AGENTS.md` dependency table.** It currently holds major-version
   constraints written before the lockfile existed. Replace them with the exact
   versions from `pnpm-lock.yaml` for the packages listed, and remove the note
   saying exact pins are pending.

8. **Document what Phase 1 deliberately does not do.** Add a short "Current
   state" section to the README listing the deferrals — no booking logic, no
   Square checkout, no waiver signing, no Klaviyo flows, no-op notification
   providers — with a pointer to `docs/vision.md` § Scope. Without this, the
   next person reads the placeholder routes as broken features rather than as
   planned scaffolding.

9. **Verify by execution.** On a clean clone in a scratch directory, follow the
   README top to bottom and confirm each step works as written. Fix the document
   wherever reality disagrees with it. This step is the workstream — a README
   that has not been walked through is not done.

## Tests

Documentation is verified by execution and by automated link and coverage
checks.

1. **Clean-clone walkthrough** — On a fresh clone, follow the README end to end.
   Assert `pnpm install`, migrations, `pnpm dev`, and `pnpm -r test` all succeed
   using only the documented commands. Record any deviation and fix the README.
2. **`.env.example` is complete** — Assert every variable read by
   `packages/database/src/env.ts`, `packages/auth/src/env.ts`, and `apps/web`
   appears in `.env.example`. A missing variable is a first-run failure for the
   next engineer.
3. **`.env.example` contains no real credentials** — Assert no value matches a
   live Neon host, an AWS access key pattern, or a Square token pattern, and
   that every value is an obvious placeholder.
4. **`.env` is ignored** — Assert `.gitignore` covers `.env` and `.env.local`,
   and that no `.env` file is tracked by git.
5. **All seven secrets are documented** — Assert `docs/environment.md` names
   every secret declared in `infra/secrets.ts`, with no extras and none missing.
6. **Documented scripts exist** — Parse every `pnpm` command in the README and
   assert each corresponds to a real script in the relevant `package.json`. This
   catches the classic drift where a script is renamed and the README is not.
7. **Internal links resolve** — Assert every relative markdown link in
   `README.md`, `CONTRIBUTING.md`, `docs/environment.md`, and
   `docs/architecture.md` points at a file that exists.
8. **Dependency table matches the lockfile** — Assert every version in the
   `AGENTS.md` table matches the resolved version in `pnpm-lock.yaml`.
9. **The pooled/direct distinction is documented** — Assert both the README and
   `docs/environment.md` state that the two URLs are not interchangeable and
   describe the startup guard.
10. **Deferrals are listed** — Assert the README's "Current state" section names
    each Phase 1 exclusion from `docs/vision.md` § Scope: Phase 1.

## Acceptance Criteria

1. A new engineer following `README.md` on a clean clone reaches a running
   application, applied migrations, a linked `sst dev` stage, and a passing test
   suite, using only documented commands (SC-09).
2. Every command in the README was executed by the author and works as written.
3. `.env.example` lists every environment variable consumed by any package, with
   placeholder values and no real credentials.
4. `.env` and `.env.local` are gitignored and untracked.
5. The pooled/direct connection-string distinction is documented in both the
   README and `docs/environment.md`, including the startup guard's error
   message.
6. `docs/environment.md` documents all seven SST secrets with the exact commands
   to set them per stage.
7. `docs/architecture.md` explains the package graph, the plain-library core
   decision, the no-Lambda-per-package rule, and the Cognito/Postgres split
   without duplicating `docs/vision.md`.
8. `CONTRIBUTING.md` documents the four-script requirement, the source-export
   convention, and the module boundaries.
9. The `AGENTS.md` dependency table holds exact versions from `pnpm-lock.yaml`,
   and the "pins pending" note is removed.
10. The README's "Current state" section lists every Phase 1 deferral.
11. Every relative markdown link across the documentation set resolves.
12. Every `pnpm` command referenced in the documentation corresponds to a real
    script.
