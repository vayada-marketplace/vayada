# VAY-1009 local import simulator

Standalone development harness, based on `engineering/shared-hotel-import-contract.md`.
This fixture slice is completed by the stacked simulator UI/test PR.
Reuses the actual PreparedHotelImportPanel; connection, listings and persistence are
simulated. No production route, database migration, provider write, or deployment.
Do not deploy this tool or treat its fake persistence as proof of server idempotency.

From the repository root (after npm ci):

```sh
PORTLESS_STATE_DIR=/tmp/vay1009-simulator-1379 PORTLESS_PORT=1379 PORTLESS_SYNC_HOSTS=0 portless pms sh -c 'npm exec -- vite --config tools/hotel-import-simulator/vite.config.ts --port "$PORT"'
npm exec -- playwright test --config tools/hotel-import-simulator/playwright.config.ts
npm exec -- vite build --config tools/hotel-import-simulator/vite.config.ts
```

Open https://pms.localhost:1379. Session storage holds only synthetic room facts.
Reset clears only this simulator's storage. Reload preserves saved results within
the tab; restart connection/selection to inspect them. External provider/API requests
are never made by the simulator. Fixtures intentionally omit photos and some facts.

Scenarios: cancelled connection, connection error, empty account, multiple listings,
edited/selected saves, missing facts, partial failure, lost response, repeated import.
The standalone UI represents connection approval locally, not a real OAuth callback.
Real auth/state/tenant checks and database concurrency need their own integration tests.

Real evidence remains separate: Channex staging link generation returned200 and opened
Airbnb login; existing Aether listing read succeeded. Fresh host authorization remains
unverified. No fictional accommodation was created on Airbnb.

Verification: standalone Vite build and TypeScript check passed. Browser tests cover
cancel/error/empty, edited save/reload, partial failure, and lost response. Independent
review found stale saved-count feedback on lost response; fixed and re-reviewed.
Ponytail pass: reuse native sessionStorage and existing shared editor; no new dependency.
Separate fresh read-only Channex check returned HTTP200, capacity2, description197
characters. No data from that real listing is stored in the synthetic fixtures.

For the shared editor backed by the real local import API and PostgreSQL, see
[the database harness](DATABASE.md). Its identity and Airbnb source are still simulated.
