# Backend Migration

`@vayada/backend-migration` owns target-schema migrations, local fixture
rebuilds, source-to-target transforms, and parity checks for the TypeScript
backend rewrite.

## Full-Fixture Smoke

Use the full-fixture smoke command after updating `main` and before marking
post-merge migration fixture coverage as accepted:

```bash
TARGET_DATABASE_URL=<local scratch target database> \
  npm --workspace @vayada/backend-migration run target:fixtures:smoke
```

The command runs every fixture case registered in `src/cases/registry.ts`. For
each case it drops and recreates the target schemas, applies all reviewed target
migrations, loads that fixture, runs its transform when one is registered, and
then runs parity checks against `expected-target.json`.

`target:fixtures:smoke` intentionally does not accept `--fixtures`; it is the
full accepted fixture matrix. Use `target:rebuild` and `target:parity` directly
when you need to debug a single fixture case.

The unit tests compare fixture manifests, registry entries, and the smoke case
list. Adding a fixture manifest without registering it, or changing the smoke
path so it omits a registered case, fails `npm test`.

## Platform Media Parity

`platform-media` is a target-only fixture that pins the registry contract before
source-backed media transforms are implemented. Media migration parity must
track:

- source URL inventory count;
- copied Vayada-managed object count;
- external-reference object count;
- unresolved external URL count;
- public/private object classification count;
- required public image variants: `original_safe`, `large`, `thumbnail`, and
  `blur_preview`;
- forbidden private values in public media objects, variant CDN URLs, or future
  public read models.

Product fixtures that later migrate Booking, Marketplace, or PMS media URLs
should reuse `platformMediaChecks` instead of creating ad hoc media assertions.

## WorkOS Backfill

Audit the migrated target identity/resource links before a backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:workos:audit
```

The audit exits non-zero when target identity tables are missing or when active
users, organizations, memberships, or required owner resource links are not
ready for AuthKit.

Production API images prune dev dependencies, so one-off ECS tasks should use
the compiled commands:

```bash
npm --workspace @vayada/backend-migration run target:migrate:dist -- --env production
npm --workspace @vayada/backend-migration run target:workos:audit:dist
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- --email user@example.com --dry-run
```

Use `--email` for one-user migration smoke tests:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email user@example.com \
    --dry-run
```

Apply mode requires the printed cohort key as a confirmation guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email user@example.com \
    --apply \
    --confirm email:user@example.com
```

Use `--cohort-manifest <path>` for reviewed batch cohorts.
Omit `WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL` to migrate identities without
importing legacy bcrypt password hashes.
