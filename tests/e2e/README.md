# Playwright E2E Pilot

This directory contains the Vayada Playwright pilot from VAY-545. It is a focused browser-smoke layer, not a replacement for build, lint, typecheck, or backend pytest.

## Commands

Run from the repo root:

```bash
npm run e2e
npm run e2e:landing
npm run e2e:booking-web
npm run e2e:headed
npm run e2e:ui
npm run e2e:report
```

By default local tests expect the app to already be running through portless:

- `https://landing.localhost`
- `https://hotel-alpenrose.booking.localhost`

To have Playwright start plain-port Next.js dev servers for the pilot apps:

```bash
E2E_START_SERVERS=1 npm run e2e
```

Plain-port server mode uses:

- `http://127.0.0.1:3006` for landing
- `http://hotel-alpenrose.booking.localhost:3002` for booking-web

Override URLs when needed:

```bash
E2E_LANDING_BASE_URL=http://localhost:3006 npm run e2e:landing
E2E_BOOKING_BASE_URL=http://hotel-alpenrose.localhost:3002 npm run e2e:booking-web
```

## Booking Tenant Smoke

The booking-web pilot verifies tenant host routing with the seeded `hotel-alpenrose` slug. It mocks the browser-side hotel, room, add-on, and tracking API calls so the smoke test can prove the storefront shell and host-derived slug without requiring a full local database bootstrap.

When testing against a real seeded backend instead of the mocked smoke, start portless wildcard mode first:

```bash
portless proxy stop
portless proxy start --wildcard
cd apps/booking-web && portless
```

Then visit `https://hotel-alpenrose.booking.localhost`.

## Debugging

CI uploads `playwright-report/` and `test-results/` on every pilot run. Open the report locally with:

```bash
npm run e2e:report
```

Traces are retained on failure locally and on first retry in CI.

## Agent Guidance

Agents should report the exact browser flow they exercised. Starting a dev server is not browser validation.

Use Playwright Test for committed regression coverage. Use Playwright CLI or the Codex in-app browser for quick exploratory checks. Use Playwright MCP only when deeper browser control, persistent state, or accessibility snapshots are worth the extra setup.
