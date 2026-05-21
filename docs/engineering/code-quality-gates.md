# Code Quality Gates

How Vayada enforces formatting, linting, typecheck, and tests across the monorepo. Pragmatic-first: the tooling is wired up, the strictness is realistic, and the codebase is not blocked while we close baseline drift.

## Stack

| Tool              | Scope                                           | Config                                                   |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------- |
| **Prettier**      | Formatting for JS/TS/JSON/Markdown/YAML/CSS     | `.prettierrc.json` + `.prettierignore` at root           |
| **ESLint**        | Lint for JS/TS (Next.js apps)                   | `eslint.next.config.mjs` at root; each app re-exports it |
| **TypeScript**    | Type checking for JS/TS apps                    | Per-app `tsconfig.json`                                  |
| **Ruff**          | Lint + format for Python                        | `[tool.ruff]` in root `pyproject.toml`                   |
| **pytest**        | Tests for Python apps                           | Per-app `pytest.ini`                                     |
| **Next.js build** | Build-time type/import errors for frontend apps | Per-app `next.config`                                    |

There is no single "lint everything" command yet — see "Running checks" below for the per-tool commands.

## Running checks

From the repo root:

```bash
# Formatting
npm run format          # prettier --write .   (JS/TS/MD/YAML/CSS/JSON)
npm run format:check    # prettier --check .   (CI-style: report only)
npm run format:python   # ruff format .        (Python)

# Lint
npm run lint            # ESLint across all frontend workspaces
npm run lint:python     # ruff check .

# Typecheck
npm run typecheck       # tsc --noEmit across all frontend workspaces

# Builds (most thorough — catches type/import errors the dev server hides)
npm run build           # all frontend workspaces

# Tests (Python; per-app)
cd apps/<app>-api && python -m pytest
```

Ruff has to be installed once per machine: `pip install ruff`. Prettier and ESLint come from `npm install` at the repo root.

## Strictness policy

The codebase was migrated from multiple repos with different historical conventions. To avoid blocking all work on a baseline reformat, the initial rule is:

- **Errors are real.** If a check exits non-zero on code you just changed, fix it.
- **Pre-existing findings are not blockers.** New code conforms; old code gets cleaned up opportunistically or in dedicated ratchet tickets.
- **Warnings stay warnings.** Don't promote ESLint warnings to errors without a dedicated ticket and a known cleanup path.

This means it is OK to land a change that leaves the global `prettier --check .` or `ruff check .` reporting issues, as long as your _touched files_ are clean.

## What's intentionally warn-only or deferred

These are deliberate choices, not accidents:

- **ESLint** (`eslint.next.config.mjs`):
  - `@typescript-eslint/no-explicit-any`, `no-empty-object-type`, `no-require-imports` — `warn`. Eradicating `any` is a long-tail ratchet.
  - `react/no-unescaped-entities`, `react/no-children-prop` — `warn`. Mostly noise in product code.
  - `react-hooks/immutability`, `preserve-manual-memoization`, `purity`, `set-state-in-effect` — `off`. The React Hooks v6 strict rules don't fit the current code; revisit after the React 19 / Next 16 settling.
- **Prettier**:
  - `.prettierignore` excludes `**/migrations/**`, `infra/.terraform/**`, build artifacts, and all Python files (Ruff owns Python formatting).
  - The 643-file initial baseline drift is **not** being reformatted in one pass. Files get reformatted when touched.
- **Ruff** (`pyproject.toml`):
  - Rules enabled: `E` (pycodestyle), `F` (pyflakes), `I` (isort), `UP` (pyupgrade), `B` (bugbear). `D` (docstrings), `N` (naming), `S` (bandit security), and others are deferred.
  - `E501` (line too long) ignored — Ruff format handles wrapping.
  - `B008` ignored — FastAPI's `Depends()` pattern triggers this falsely.
  - Tests get a permissive `per-file-ignores` block (fixtures freely re-import, unused symbols are expected).

When a deferred rule eventually graduates to enforced, it gets its own follow-up ticket so the cleanup is scoped.

## CI enforcement

Currently the per-app GitHub Actions workflows run that app's own checks (typically `npm run build` for frontends and `pytest` for Python). There is **no** root-level "check everything" CI job — and that's intentional until VAY-458 lands pre-commit/pre-push hooks and ratchets baseline drift down.

When the baseline is clean enough to enforce globally, add a `.github/workflows/quality.yml` that runs:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
pip install ruff
ruff check .
```

That issue lives downstream of cleanup work, not before it.

## Git hooks

Local hooks run automatically on commit and push. They are advisory: CI is still the authoritative gate.

| Hook         | What runs                                                                                                                     | When it fires      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `pre-commit` | `lint-staged` — Prettier + ESLint --fix on touched JS/TS, Prettier on MD/YAML/CSS/JSON, Ruff check + format on touched Python | Every `git commit` |
| `pre-push`   | `npm run typecheck` across workspaces                                                                                         | Every `git push`   |

Both hooks operate on touched files only (or `--if-present` workspaces), so baseline drift is **not** a blocker for unrelated commits.

### Install

Hooks install automatically on `npm install` at the repo root via the `prepare` script (husky 9). Running `npm install` once after cloning is enough. To reinstall manually:

```bash
npx husky
```

### Bypass policy

Hooks exist to catch obvious mistakes before they hit CI. Bypassing is allowed for legitimate emergencies, but **always with a reason**:

- `git commit --no-verify` — skip pre-commit.
- `git push --no-verify` — skip pre-push.

Agents (Codex, Claude Code, etc.) must **not** bypass hooks without explicit user permission for that specific operation. The default is to fix the issue the hook flagged, not work around it.

If a hook keeps flagging false positives, fix the hook config — don't normalize `--no-verify`.

## Ratchets — known follow-ups

- Reformat the codebase with `npm run format` and `ruff format .` in a single dedicated commit, then enable CI enforcement. (Single big diff, easier to review than incremental.)
- Bulk-fix the 2050 auto-fixable Ruff findings with `ruff check --fix .` in a single commit.
- Add `typecheck` scripts to frontend workspaces so `npm run typecheck` (and therefore pre-push) actually exercises them — today only `docs` has it.
- Once stable, promote ESLint warnings to errors in a follow-up; same for tightening Ruff rule set.

None of these block product work today.
