# Local database import test

This second harness uses the production prepared-import route, canonical property
provisioning and PMS room commands with PostgreSQL. Identity, connection approval,
and listing data remain synthetic. It renders the shared onboarding review editor,
not the complete signup page. It seeds an accepted invitation because that is the
current production source contract; it does not implement a new Airbnb source.
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
