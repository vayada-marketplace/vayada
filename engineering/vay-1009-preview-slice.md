# VAY-1009: example-backed PMS room preview slice

This slice implements the user-approved local integration experiment, not the full URL-extraction acceptance criteria of VAY-1009. The live provider service, URL validation, source deduplication, onboarding adapters and invite logic remain separate work.

Reuse product-onboarding for a provider-neutral room review component. It receives a candidate and returns only explicitly selected editable facts; it has no API or persistence access. PMS chooses its form adapter and existing create command. The experiment is gated by NODE_ENV != production AND NEXT_PUBLIC_ROOM_IMPORT_PREVIEW_ENABLED=true. It uses fictional example data and cannot imply an active Airbnb connection.

Show the choice before mounting the existing RoomTypeForm, because that form maintains local bed/count/input state. Apply once to the initial draft or start manually; no remount of an edited form and no silent replacement of user work. Pricing, currency, inventory, photos, and cancellation stay on the ordinary form and are never sourced from the example. Existing create remains explicit.

Validation: component selection/cancel/apply tests, adapter preservation tests, PMS build/lint, shared consumer checks, browser review/apply/manual flows. Real-account persistence testing must be reported separately from fixture/mock evidence. Keep the sample unavailable on deployed production-mode builds.

For local review, set `NEXT_PUBLIC_ROOM_IMPORT_PREVIEW_ENABLED=true` before starting PMS through `npm run dev:portless`. Open Rooms & Rates → New Room Type → Review example. Onboarding query routes skip this experiment.

Run the focused browser pilot with the same flag in the test process and `E2E_PMS_BASE_URL` pointing to that PMS server:

```sh
NEXT_PUBLIC_ROOM_IMPORT_PREVIEW_ENABLED=true npm run e2e:pms-web -- tests/e2e/pms-web/room-import-preview.spec.ts
```

The pilot uses mocked authentication and API reads. It verifies cancel, selection, editable name/description/capacity prefill, and manual start without a create request. It does not validate actual room persistence or provider extraction. The shared component is currently English-only for the local experiment.
