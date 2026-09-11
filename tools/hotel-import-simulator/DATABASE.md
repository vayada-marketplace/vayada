# Local database import test

This second harness uses the production prepared-import route, canonical property
provisioning and PMS room commands with PostgreSQL. Identity, connection approval,
and listing data remain synthetic. It renders the shared onboarding review editor,
not the complete signup page. The original `/database.html` flow uses an accepted
invitation. The optional Airbnb callback smoke uses separate source and receipt
repositories with synthetic provider approval/listing facts.
Do not deploy it. No provider clients, real credentials or OTA writes are involved.

Run from the repository root after npm ci. The fixed database/container/ports are
reserved for this experiment; do not substitute a shared or remote database.

```sh
docker run -d --name vay1009-import-test -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=vay1009_import_test -p 127.0.0.1:59709:5432 postgres:17
npm run build:backend-packages --workspace=vayada-api
npx tsx packages/backend-migration/src/cli/migrate.ts --connection-string postgresql://postgres@127.0.0.1:59709/vay1009_import_test
PORTLESS_STATE_DIR=/tmp/vay1009-real-import-1380 PORTLESS_PORT=1380 PORTLESS_SYNC_HOSTS=0 portless pms npx tsx tools/hotel-import-simulator/database-server.ts
```

Reuse the container when it already exists. Open
[the database demo](https://pms.localhost:1380/database.html). The API binds loopback,
requires an ephemeral token held by Vite, and rejects other browser origins at the
proxy. This is test authentication, not WorkOS evidence. Do not expose the proxy.

```sh
npx tsc -p tools/hotel-import-simulator/tsconfig.json
npx playwright test --config tools/hotel-import-simulator/database-playwright.config.ts
```

The browser suite preserves existing database data. On a fresh Garden listing it
checks edit/save; on subsequent runs it checks replay and preserves the saved
name. Incomplete-listing checks compare against their own starting room data.
Do not reset the database to repeat these checks.

Coverage: edit/save through the browser, reload persistence, simultaneous replay
without duplicate or overwritten edits, incomplete/unknown input, wrong-property
access, cross-origin writes, direct backend access, and missing-facts guidance.
The fixtures create room types only; no physical room units, rates or publication.
The original session-storage simulator remains available on port 1379.

The Airbnb source-storage slice adds migration 0179 and an internal repository.
Its integration test uses this same reserved database, creates unique synthetic
users/organizations/properties, then removes only those records. It does not reset
the demo or perform provider requests. With migration 0179 applied, run from
`apps/api`:

```sh
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:59709/vay1009_import_test npx vitest run src/airbnbImportSourceRepository.integration.test.ts
```

For the existing older demo migration ledger, validation applied only the new
0179 SQL through the migration runner's `--migrations-dir` option, using a temporary
directory containing that file. No historical migration was changed or replayed.
This verifies the new table against local fixtures, not a full production migration.

## Airbnb source to canonical room smoke

With migrations 0179 and 0182 already applied, restart the database harness above.
Start the isolated Marketplace frontend with `AIRBNB_IMPORT_CALLBACK_ENABLED=true`
and the portless configuration in [PRODUCT-PAGES.md](PRODUCT-PAGES.md), then run:

```sh
E2E_AIRBNB_IMPORT_DATABASE=1 E2E_MARKETPLACE_BASE_URL=https://marketplace.localhost:1382 npx playwright test tests/e2e/marketplace-web/airbnb-import-database.spec.ts --project=marketplace-web-chromium --workers=1
```

The test drives the actual callback/review UI. Its browser interceptor forwards
import requests to the token-protected local harness; it does not mock import
responses. The provider link/listing ports and identity are synthetic. It verifies
room persistence, a lost save response, reload, and concurrent replay after removing
only that run's receipt. Real draft-room bindings recover the same room identity.

Each run leaves one uniquely named synthetic room type and its source/receipt for
inspection. Existing demo records remain intact; no physical rooms, rates or provider
writes are requested. Restore the callback flag to false after the smoke. This is
local database evidence, not real Airbnb authorization or deployed acceptance.
