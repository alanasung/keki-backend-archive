# WS-01: Monorepo foundation and toolchain

## Goal

Create the pnpm workspace, TypeScript baseline, linting, formatting, and the
four verify scripts that every later workstream depends on. This workstream is
what makes the `verify` commands already configured in `pipeline.config.json`
(`pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`) resolve
and pass. Until it lands, no workstream can self-verify.

No application code, no packages with real content — directory skeletons and
configuration only.

## Traceability

- **SC-06** — Every shared package compiles independently (`pnpm -r typecheck` passes).
- **SC-01** — Partially: establishes the root `dev` script that WS-08 makes functional.

## Dependencies

None. This is the first workstream in the program.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — full file; note the "Module boundaries" and "Delivery" conventions
- `docs/vision.md` — sections "Architecture", "Technology Stack", "Scope: Phase 1"
- `pipeline.config.json` — the `verify` block; its four commands are the contract this workstream must satisfy

## Package

Repository root (`.`).

## Files Touched

- `package.json` (NEW) — root workspace manifest and scripts
- `pnpm-workspace.yaml` (NEW) — workspace globs
- `.npmrc` (NEW) — pnpm settings
- `tsconfig.base.json` (NEW) — shared compiler options
- `tsconfig.json` (NEW) — root solution config
- `eslint.config.mjs` (NEW) — flat ESLint config
- `.prettierrc.json` (NEW) — formatter config
- `.prettierignore` (NEW)
- `.nvmrc` (NEW) — Node version pin
- `.gitignore` (MODIFY) — add Node, Next, SST, and build artifacts
- `.editorconfig` (NEW)

## Existing Interfaces to Consume

None. This is the first workstream of the first program; the repository
contains only pipeline documentation at this point.

## Implementation Steps

1. **Pin the runtime.** Write `.nvmrc` with `22`. Node 22 is the current LTS and
   is supported by both SST 3 and OpenNext.

2. **Create `pnpm-workspace.yaml`** with three globs:

   ```yaml
   packages:
     - 'apps/*'
     - 'packages/*'
     - 'functions/*'
   ```

3. **Create `.npmrc`:**

   ```
   node-linker=isolated
   strict-peer-dependencies=false
   auto-install-peers=true
   ```

   `strict-peer-dependencies=false` is required because SST and OpenNext have
   loose peer ranges against Next 15.

4. **Create the root `package.json`.** Set `"private": true`,
   `"packageManager": "pnpm@9.x"` (pin the exact 9-series version installed),
   and `"engines": { "node": ">=22" }`. Scripts:

   ```json
   {
     "dev": "pnpm --filter web dev",
     "typecheck": "pnpm -r typecheck",
     "lint": "pnpm -r lint",
     "test": "pnpm -r test",
     "build": "pnpm -r build",
     "format": "prettier --write .",
     "format:check": "prettier --check ."
   }
   ```

   The four middle scripts mirror `pipeline.config.json`'s `verify` block
   exactly. Do not rename them.

5. **Establish the "every package defines all four scripts" rule.** `pnpm -r <script>`
   fails if a workspace package lacks the script. Every package created by
   WS-02 through WS-11 must define `typecheck`, `lint`, `test`, and `build`.
   Record this in `AGENTS.md` under Conventions → Delivery so later workstreams
   inherit it. Do **not** use `--if-present` to paper over missing scripts; a
   package without a test script should define one that runs its (possibly
   empty) Vitest project.

6. **Create `tsconfig.base.json`** with `strict: true`, `target: "ES2022"`,
   `lib: ["ES2022"]`, `module: "ESNext"`, `moduleResolution: "Bundler"`,
   `esModuleInterop: true`, `skipLibCheck: true`, `noEmit: true`,
   `isolatedModules: true`, `resolveJsonModule: true`,
   `forceConsistentCasingInFileNames: true`, plus `noUncheckedIndexedAccess: true`
   and `exactOptionalPropertyTypes: true`.

   `moduleResolution: "Bundler"` is correct for every package here: Next
   transpiles the app, and SST bundles the Lambda handlers with esbuild. No
   package emits its own JavaScript.

7. **Create the root `tsconfig.json`** extending the base with `"files": []`.
   Do not use TypeScript project references — each package typechecks
   independently via its own `tsconfig.json`, which is what SC-06 requires and
   what keeps `pnpm -r typecheck` meaningful.

8. **Adopt the source-export convention for internal packages.** Each
   `packages/*` manifest points `main`, `types`, and `exports` at
   `./src/index.ts` rather than a built `dist/`. Consumers compile the source:
   Next via `transpilePackages`, Lambdas via esbuild. Consequently a library's
   `build` script is `tsc --noEmit -p tsconfig.json` — a compile gate, not an
   emit step. Document this in `AGENTS.md` Conventions so later workstreams do
   not invent a per-package emit pipeline.

9. **Create `eslint.config.mjs`** in flat-config form with
   `@eslint/js` recommended, `typescript-eslint` recommended-type-checked, and
   an import-boundary rule via `eslint-plugin-import` that forbids
   `packages/*-core` from importing `apps/**`. This encodes the `AGENTS.md`
   module-boundary convention as an executable check rather than a comment.

10. **Create `.prettierrc.json`** (2-space indent, single quotes, no semicolon
    preference is fine — pick one and be consistent), `.prettierignore`
    (ignore `.next`, `.sst`, `.open-next`, `node_modules`, `drizzle`
    generated SQL), and `.editorconfig`.

11. **Extend `.gitignore`.** The file currently contains only `build-logs/`.
    Append `node_modules/`, `.next/`, `.sst/`, `.open-next/`, `dist/`,
    `.env`, `.env.local`, `coverage/`, `playwright-report/`,
    `test-results/`, `*.tsbuildinfo`. Do not remove the existing
    `build-logs/` entry.

12. **Create empty package directories** so the workspace globs resolve:
    `apps/`, `packages/`, `functions/`. Add a `.gitkeep` to each — later
    workstreams populate them.

13. **Install dependencies** with `pnpm install` and commit the resulting
    `pnpm-lock.yaml`.

14. **Verify.** Run all four verify commands. With no packages yet, `pnpm -r`
    is a no-op success; that is the expected state and confirms the scripts
    resolve. Run `pnpm format:check` and fix any violations.

## Tests

There is no application code to unit test in this workstream. Verification is
by executing the toolchain itself.

1. **Workspace resolves** — Run `pnpm install`. Expect exit code 0 and a
   generated `pnpm-lock.yaml`. Assert `pnpm-workspace.yaml` globs produce no
   "no projects matched" error.
2. **Verify scripts resolve** — Run each of `pnpm -r typecheck`, `pnpm -r lint`,
   `pnpm -r test`, `pnpm -r build`. Each must exit 0. Assert none reports an
   unrecognized script.
3. **TypeScript base config is valid** — Run `pnpm exec tsc -p tsconfig.json --noEmit`.
   Expect exit 0 and no configuration diagnostics.
4. **ESLint config loads** — Run `pnpm exec eslint --print-config package.json`.
   Expect exit 0 and JSON output, confirming the flat config parses.
5. **Prettier is consistent** — Run `pnpm format:check`. Expect exit 0.
6. **Node version pin is readable** — Assert `.nvmrc` exists and its contents
   parse as a major version `>= 22`.

## Acceptance Criteria

1. `pnpm install` completes with exit code 0 and `pnpm-lock.yaml` is committed.
2. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, and `pnpm -r build` all
   exit 0, and their names match `pipeline.config.json`'s `verify` block exactly.
3. `pnpm-workspace.yaml` declares exactly the three globs `apps/*`,
   `packages/*`, and `functions/*`.
4. `tsconfig.base.json` sets `strict: true` and `noEmit: true`, and defines no
   TypeScript project references.
5. `eslint.config.mjs` loads without error and contains a rule forbidding
   `packages/*-core` from importing `apps/**`.
6. `.gitignore` retains `build-logs/` and additionally ignores `node_modules/`,
   `.next/`, `.sst/`, `.open-next/`, and `.env*`.
7. `AGENTS.md` Conventions section documents both the four-script requirement
   and the source-export convention for internal packages.
8. `pnpm format:check` exits 0.
9. No file under `apps/`, `packages/`, or `functions/` contains application
   logic — only `.gitkeep` placeholders.
