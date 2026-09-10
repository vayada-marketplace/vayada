# Import through the actual product pages

Extends [the database harness](DATABASE.md) with the production PMS room-read
routes and property-access repository. The synthetic owner has a real database
membership and assignment to exactly the synthetic property. No production
permission checks are bypassed inside the tested routes.

Contract: [shared hotel import](../../engineering/shared-hotel-import-contract.md).
This test covers the existing invitation-prepared source and an already selected
property. It does not implement an Airbnb source, test fresh OAuth, create a new
user through signup, or validate the entire setup wizard and its launch readiness.

Start the database harness on port 1380 with a fresh dedicated database, following
DATABASE.md. Do not run database.spec.ts first: both suites require fresh data.
The full local launcher may be unavailable when another checkout owns its shared
Docker stack. In that case, leave that stack alone and run these isolated frontends
from the repository root in separate terminals:

```sh
PORTLESS_STATE_DIR=/tmp/vay1009-product-pages-1382 PORTLESS_PORT=1382 PORTLESS_SYNC_HOSTS=0 AUTH_PUBLIC_ORIGIN=https://marketplace.localhost:1382 NEXT_PUBLIC_AUTH_API_URL=https://api.localhost:1382 NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true portless marketplace npm run dev --workspace=apps/marketplace-web
PORTLESS_STATE_DIR=/tmp/vay1009-product-pages-1382 PORTLESS_PORT=1382 PORTLESS_SYNC_HOSTS=0 AUTH_PUBLIC_ORIGIN=https://pms.localhost:1382 NEXT_PUBLIC_AUTH_API_URL=https://api.localhost:1382 NEXT_PUBLIC_PMS_OPERATIONS_API_URL=https://api.localhost:1382 NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=false portless pms npm run dev --workspace=apps/pms-web
npx playwright test --config tools/hotel-import-simulator/product-pages-playwright.config.ts
```

Playwright supplies synthetic auth and unrelated setup responses only inside its
browser context. Import reads/writes and PMS room/physical-unit/linked-inventory
reads go to the real local routes and PostgreSQL. Unknown API requests return an
explicit test error; they never fall through to remote or shared services.
Consequently opening these frontend URLs outside Playwright still requires login;
use the port-1380 database demo for the interactive simulated journey.

The test opens Marketplace `/setup`, edits the missing-facts loft, checks that the
validation message includes beds, supplies those facts, and saves. It then opens
PMS `/rooms`, verifies the imported loft, imports the garden suite there, and
reloads to verify both names remain. Screenshots are saved in test-results.

Validation: product-page browser test, strict harness TypeScript, and four shared
import-panel unit tests pass. The only product change is clearer missing-bed
validation guidance. Canonical save, property assignment, and room reads are real;
authentication, prepared source, setup readiness and unrelated APIs are fixtures.
