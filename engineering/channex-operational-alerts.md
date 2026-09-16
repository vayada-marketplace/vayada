# Channex operational alerts (VAY-846)

Implements the September 7 clarification alongside the VAY-839 event strategy.
Receipt intake writes only alert/receipt state. Recovery is separately authorized
with the existing PMS permission/entitlement boundary and mutation capabilities.

Alerts are bound to the resolved property and Channex binding generation. A
partial unique index groups unresolved problems; receipt links retain occurrence
history. Transport replays never create another recovery. Older events cannot
resolve a newer incident. Acknowledging an alert means seen, never fixed.

Recovery uses canonical booking ingestion and management jobs with stable keys
and existing five-attempt limits. Mapping is explicitly corrected in the existing
channel settings iframe; authoritative revisions must contain mappings before
recovery imports them. Booking acknowledgement follows durable persistence.
Successful feed handoff alone is not successful ingestion. ARI recovery checks
provider warnings and reads back submitted values before claiming Channex recovery;
OTA delivery remains unverified. Disconnection recovery requires current provider
channel activation, then booking and ARI synchronization.

Provider reference, checked September 7, 2026:
https://docs.channex.io/api-v.1-documentation/webhook-collection
Documented mapping events contain booking/revision IDs; missing impact stays
unknown. Missing-ack payloads may contain guest names: these are never projected.
Sync errors contain channel_id/channel_event_id/error_type. Unspecified warning,
rate-error and disconnection fields are optional hints, never mutation input.

VAY-844 owns activating the additional event masks; VAY-845 owns booking webhook
promotion; VAY-947 owns callback cutover in the VAY-1362 window. This change does
not modify subscriptions, callback URLs or mutation ownership. Provider replay
and subscription coverage remain required before activation, including confirming
the disconnected_channel payload against the deployed provider version.

Provider compatibility (September 12, 2026): subscribe to the documented
`disconnect_channel` event. Intake normalizes it to the existing
`disconnected_channel` alert category while retaining the raw provider payload;
legacy receipts and the PMS recovery contract keep their existing name.

## Exact staging missing-ACK recovery (VAY-846)

The operator CLI prepares a single non-acked alert round for an already persisted
revision. Approval is a non-runnable staging job, bound to alert, round, property,
provider identity, binding generation, canonical booking and an expiry of one hour.
Preparation does not ACK or change business data. Repeating preparation never renews
or replaces an existing grant. Only the normal authorized PMS recovery click links
and schedules the job; only the explicit scoped CLI executes it. Ordinary workers
exclude staging jobs. No browser-supplied scope or property-wide mode change exists.

The worker requires the approved mapping/revision/canonical booking under its
transaction lock before taking the replay branch, and rechecks expiry, binding and
alert linkage before ACK. Mapping drift cannot fall through into import or repair.
Successful linked worker completion supplies the existing verified-resolution proof.
The per-alert availability flag does not change property mutation capabilities.
An already acknowledged synthetic revision proves retry behavior, not an actual
missing provider ACK. Fixture assignment, staging deployment and shared-window
coordination remain separate prerequisites for a deployed test.
