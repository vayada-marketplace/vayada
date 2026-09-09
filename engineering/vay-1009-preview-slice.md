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

## Connected Airbnb saved-read MVP

The local experiment also accepts a saved Channex read as JSON containing `name`, `description`, `maxGuests`, and `checkedAt`. Files are limited to 16 KB and parsed only in the browser; uploaded source labels are never treated as verified provenance. Only the three supported facts can reach the room form. This manual snapshot bridge validates real provider output against the UI before adding a property-scoped HTTP adapter. It does not provide one-click account connection or runtime provider fetching.

On 2026-09-09 a fresh, authorized Channex GET returned Aether Hilltop Villa 3 with capacity 2 and a 197-character description. The credential stayed in memory and the minimal snapshot stayed outside the repository. No provider writes, photo downloads or room creation occurred. The connected-import track uses Channex; the separate Apify adapter is not a prerequisite.

Set `E2E_CHANNEX_PREVIEW_FILE` to a local snapshot path to exercise that data through the focused pilot; without it the same test uses synthetic facts. Authentication and PMS API reads are still mocked, so this proves provider-read → reviewed prefill, not authorized product-endpoint access or persistence. The normal room save remains separate; do not save the source hotel's facts into an unrelated test property.

Validation: 11 component tests and all 4 focused browser tests passed, including the real saved Channex read through preview and all three prefilled form fields. Browser authentication and read routes were mocked; no room was saved. PMS production build passed; lint had zero errors and 63 existing warnings. Independent adversarial review found no actionable defects. Complexity review found no additional abstractions or dependencies to remove.
