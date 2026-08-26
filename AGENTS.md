# Repository Guidelines

## Project Structure & Module Organization

LedgerLens is a TypeScript application built with Vinext/Vite. Pages, UI, and server routes live in `app/`; API handlers follow `app/api/<feature>/route.ts`. Domain logic is grouped under `lib/` (`portfolio`, `analytics`, `history`, `cashflow`, `automation`, and `toss`). Database bindings and migrations are in `db/` and `drizzle/`. Relay and Worker code lives in `infra/relay/` and `worker/`. Put assets in `public/`, operational notes in `docs/`, and regression tests in `tests/`.

## Build, Test, and Development Commands

Use Node.js `>=22.13.0`; call `npm.cmd` in PowerShell to avoid the `npm.ps1` execution-policy shim.

- `npm.cmd install` installs locked dependencies.
- `npm.cmd run dev` starts the local Vinext development server.
- `npm.cmd run build` creates the production build.
- `npm.cmd run start` serves the built application.
- `npm.cmd run lint` runs ESLint across TypeScript, React, accessibility, and Hooks rules.
- `npm.cmd test` builds first, then runs the Node test suite.
- `npm.cmd run db:generate` creates Drizzle migrations after schema changes.

## Coding Style & Naming Conventions

Follow the existing ESM style: two-space indentation, semicolons, double quotes, and trailing commas in multiline constructs. TypeScript is strict; prefer explicit domain types over `any`. Name components and exported types in `PascalCase`, functions and variables in `camelCase`, and tests as `<feature>.test.mjs`. Keep route handlers thin and move validation, storage, and calculations into `lib/`. Use the `@/*` path alias for clear imports. Run ESLint before submitting changes.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`; some load TypeScript modules through Vite. Add regression coverage for changed API contracts, validation boundaries, financial calculations, cache headers, and read-only safeguards. Tests must be deterministic and must not require live Toss credentials, production D1 data, deployed relays, or Cron triggers. There is no numeric coverage threshold; successful `npm.cmd run lint` and `npm.cmd test` are the acceptance baseline.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, with both plain summaries and prefixes such as `feat:`. Prefer `type: concise summary` and keep each commit focused. Pull requests should explain behavior and security impact, list verification commands, link issues, and include before/after screenshots for UI changes. Call out migrations, environment changes, and deployment steps explicitly.

## Security & Configuration

Copy `.env.example` to `.env.local`; never commit secrets or expose them through `NEXT_PUBLIC_*`. Preserve the read-only Toss boundary: do not add order execution or a general-purpose proxy. Treat relay deployment, IP allowlisting, Cron activation, and live-data claims as separately verified operational work.
