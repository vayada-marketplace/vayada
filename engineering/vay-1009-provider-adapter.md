# VAY-1009 provider adapter

Stack: follows the review UI in PR #1802. This slice adds an executable server-side Apify adapter; HTTP authorization, UI wiring and deployment follow separately. It does not complete VAY-1009.

Accept only direct HTTPS `airbnb.com/rooms/<id>` and `booking.com/hotel/<country>/<slug>.html` links, with optional `www`. Strip tracking parameters and fragments before sending one canonical URL to a fixed Apify actor. Booking requires valid `checkin`/`checkout` dates in the submitted URL; pass them as actor inputs, not tracking parameters. Missing dates fail before a paid call; never invent dates. Do not fetch submitted URLs from our network. Reject credentials, non-default ports, lookalike hosts and search/share URLs. Regional Airbnb hosts require an explicit future allowlist.

The adapter uses `tri_angle/airbnb-rooms-urls-scraper` and `voyager/booking-scraper`. Inject the token server-side; never send it to the browser or include it in URLs/errors. Limit each run to one listing, 60 seconds, a $0.05 provider charge cap and a bounded response; do not automatically retry a billed operation. A lost connection may leave an actor running until its provider timeout.

Return only selected room facts supported by the documented output: Airbnb title/description/personCapacity; Booking roomType names deduplicated from its room offers. Booking `persons` is offer occupancy, not necessarily maximum capacity, and hotel description is not a room description. Do not infer these fields. Missing values stay absent, with an explicit review warning. Reject unrelated result URLs, empty output and malformed payloads. No rates, photos, guest/host data, database writes or channel connections.

The next route must authorize property-linked room-management access before calling the adapter, limit repeat submissions, and expose clear unavailable/timeout/empty errors. The next UI must handle missing fields without invented defaults and retain explicit normal room creation. Live output must be verified before a production rollout.

References checked 2026-09-09:

- [Airbnb direct URL actor](https://apify.com/tri_angle/airbnb-rooms-urls-scraper)
- [Airbnb output schema example](https://apify.com/tri_angle/airbnb-scraper)
- [Booking actor and room offers](https://apify.com/voyager/booking-scraper)
- [Booking actor inputs](https://apify.com/voyager/booking-scraper/input-schema)
- [Apify synchronous dataset endpoint](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post)

Validation uses synthetic fixtures shaped like the documented outputs, not a live extraction. Run `npx vitest run src/domains/pmsListingImport.test.ts` from `apps/api`. No Apify credential was available during implementation.
