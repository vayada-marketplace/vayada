# Workspace Package Manager

Vayada uses npm workspaces for the initial monorepo JavaScript workspace.

## Decision

Use npm workspaces at the repository root.

## Rationale

- All imported frontend and docs apps already use npm and `package-lock.json`.
- App-local `npm install`, `npm run dev`, `npm run build`, and `npm run lint`
  continue to work during the migration.
- Root workspace scripts can orchestrate common frontend/docs commands without
  changing every app at once.
- A root `package-lock.json` gives reproducible root workspace installs while
  app-local lockfiles are still retained during the transition.
- `packages/*` is reserved for shared JavaScript/TypeScript packages when there
  is real shared code to extract.

Do not introduce pnpm or Yarn until there is a separate migration issue that
handles lockfile changes, CI changes, and Docker build changes together.

## Layout

```text
apps/*      Product frontend workspaces
docs        Docusaurus docs workspace
packages/*  Future shared packages
```

Python apps under `apps/*-api` remain outside the npm workspace and keep their
own `requirements.txt` / pytest workflow.

## Commands

Run app-local commands exactly as before:

```bash
cd apps/booking-web
npm install
npm run dev
```

Run workspace commands from the repo root:

```bash
npm ci
npm run dev:booking-web
npm run build:booking-web
npm run lint:booking-web
npm run build
npm run lint
```

`npm run build`, `npm run lint`, and `npm run typecheck` run across all
workspaces that define the matching script.
