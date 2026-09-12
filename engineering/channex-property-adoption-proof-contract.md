# Channex property adoption proof contract

_VAY-1320 decision record. Builds on
[`pms-channex-management-contract.md`](pms-channex-management-contract.md),
[`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md), and the
VAY-1366 binding-claim registry._

## Status

Approved product decision. Implementation and any production execution require
their own reviewed tickets and rollout approval.

## Decision

Controlled legacy-to-target migration uses a cryptographically signed adoption
manifest. The manifest binds one immutable VAY-1351 source extraction run to
exactly one legacy PMS hotel, one Channex external property, one canonical
target property, and one target organization.

This is not a self-service ownership check. A hotel user cannot create or
submit the manifest, and no Channex API key crosses the target API. Only the
approved migration/cutover runner may verify and consume it.

The manifest may create a `verified_non_active` claim in
`pms.channel_binding_claims`. It does not activate a connection, import a
booking, acknowledge a webhook, install an application, push ARI, stop legacy
polling, or transfer mutation ownership. Those effects remain behind their
separate cutover gates.

Self-service adoption remains deferred until Channex offers a provider-backed,
machine-verifiable delegated authorization or ownership proof.

## Why this replaces the temporary-key proposal

Channex documents selected-property API keys and manual key withdrawal, but its
public contract does not expose a key-status endpoint, provider-enforced expiry,
or an immutable withdrawal receipt. A failed request cannot prove that a key is
permanently inactive. Requiring such a key would therefore add a write-capable
secret without completing the ownership proof.

The migration already has a stronger closed-world source: the immutable source
run contains the legacy connection, mappings, bookings, and hotel ownership.
The runner recomputes the corresponding canonical target links, and both sides
must agree before adoption. Signing the exact evidence set makes operator
approval tamper-evident and replay-bound without creating a new provider
credential.

Provider references:

- [Channex API key access](https://docs.channex.io/application-documentation/api-key-access)
- [Channex Properties API](https://docs.channex.io/api-v.1-documentation/hotels-collection)

## Manifest contract

The canonical JSON payload uses contract version
`channex-property-adoption.v1` and contains exactly:

| Field                     | Requirement                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `contractVersion`         | Literal `channex-property-adoption.v1`.                                                              |
| `manifestId`              | Unique UUID for this approval.                                                                       |
| `issuedAt` / `expiresAt`  | UTC timestamps. Expiry must fall inside the approved migration window.                               |
| `environment`             | Exact target environment; production and non-production manifests cannot be reused.                  |
| `sourceEnvironment`       | Exact VAY-1360 source environment paired with the target environment.                                |
| `sourceRunId`             | Completed immutable VAY-1351 extraction run ID.                                                      |
| `sourceSchemaRevision`    | Exact source-inventory revision verified for the run.                                                |
| `sourceEvidenceSha256`    | SHA-256 of the ordered source database/table ledger used by the proof.                               |
| `legacyPmsHotelId`        | Exact staged `pms.hotels.id` owning the Channex connection.                                          |
| `externalPropertyId`      | Exact `pms.channex_connections.channex_property_id`.                                                 |
| `targetPropertyId`        | Exact canonical `hotel_catalog.properties.id`.                                                       |
| `targetOrganizationId`    | Exact active hotel-group organization linked to the target property.                                 |
| `targetSourceLinkId`      | Exact active `hotel_catalog.property_source_links` row linking `pms.hotels` to the target property.  |
| `legacyResourceLinkId`    | Exact active `pms` / `pms_hotel` operator link from the legacy hotel to the target organization.     |
| `targetResourceLinkId`    | Exact active owner/operator `hotel_catalog` / `property` canonical ownership link.                   |
| `targetPmsResourceLinkId` | Exact active owner/operator `pms` / `pms_property` operational link for the canonical property.      |
| `legacyEvidence`          | The exact typed source-row evidence defined below.                                                   |
| `targetEvidence`          | The exact typed target-row evidence defined below.                                                   |
| `approvalSubjectSha256`   | Domain-separated hash of the approval-neutral payload defined below.                                 |
| `approvalEvidence`        | Two distinct immutable migration/security approval records, each bound to the approval-subject hash. |
| `signingKeyId`            | Allowlisted deployment signing-key identifier and version.                                           |

The detached signature is calculated over the UTF-8 bytes of the RFC 8785 JSON
Canonicalization Scheme payload. Input parsing rejects duplicate or unknown
fields before canonicalization. All timestamps are RFC 3339 UTC values with
exactly three fractional-second digits. UUIDs and SHA-256 hex values are
lowercase. Evidence arrays are sorted by source table, row ordinal, and row
checksum; approval records are sorted by authority and record ID. Numeric
counts are non-negative JSON integers. No other numeric values are permitted.

The following JSON Schema is normative. Every object rejects additional
properties. `uuid`, `timestamp`, and `sha256` below mean the lowercase UUID,
millisecond UTC timestamp, and lowercase 64-character hexadecimal forms just
defined.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://vayada.com/schemas/channex-property-adoption.v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "contractVersion",
    "manifestId",
    "issuedAt",
    "expiresAt",
    "environment",
    "sourceEnvironment",
    "sourceRunId",
    "sourceSchemaRevision",
    "sourceEvidenceSha256",
    "legacyPmsHotelId",
    "externalPropertyId",
    "targetPropertyId",
    "targetOrganizationId",
    "targetSourceLinkId",
    "legacyResourceLinkId",
    "targetResourceLinkId",
    "targetPmsResourceLinkId",
    "legacyEvidence",
    "targetEvidence",
    "approvalSubjectSha256",
    "approvalEvidence",
    "signingKeyId"
  ],
  "properties": {
    "contractVersion": { "const": "channex-property-adoption.v1" },
    "manifestId": { "$ref": "#/$defs/uuid" },
    "issuedAt": { "$ref": "#/$defs/timestamp" },
    "expiresAt": { "$ref": "#/$defs/timestamp" },
    "environment": { "enum": ["local", "staging", "preprod", "production"] },
    "sourceEnvironment": { "enum": ["local", "staging", "preprod"] },
    "sourceRunId": { "type": "string", "pattern": "^vay1351-[0-9a-f]{24}$" },
    "sourceSchemaRevision": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "sourceEvidenceSha256": { "$ref": "#/$defs/sha256" },
    "legacyPmsHotelId": { "$ref": "#/$defs/uuid" },
    "externalPropertyId": { "$ref": "#/$defs/uuid" },
    "targetPropertyId": { "$ref": "#/$defs/uuid" },
    "targetOrganizationId": { "$ref": "#/$defs/uuid" },
    "targetSourceLinkId": { "$ref": "#/$defs/uuid" },
    "legacyResourceLinkId": { "$ref": "#/$defs/uuid" },
    "targetResourceLinkId": { "$ref": "#/$defs/uuid" },
    "targetPmsResourceLinkId": { "$ref": "#/$defs/uuid" },
    "legacyEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "hotel",
        "connection",
        "roomTypeMappings",
        "ratePlanMappings",
        "bookingMappings",
        "bookings"
      ],
      "properties": {
        "hotel": { "$ref": "#/$defs/hotelEvidence" },
        "connection": { "$ref": "#/$defs/rowEvidence" },
        "roomTypeMappings": { "$ref": "#/$defs/aggregateEvidence" },
        "ratePlanMappings": { "$ref": "#/$defs/aggregateEvidence" },
        "bookingMappings": { "$ref": "#/$defs/aggregateEvidence" },
        "bookings": { "$ref": "#/$defs/aggregateEvidence" }
      }
    },
    "targetEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "property",
        "sourceLink",
        "legacyResourceLink",
        "targetResourceLink",
        "targetPmsResourceLink",
        "organization",
        "bindingClaims"
      ],
      "properties": {
        "property": { "$ref": "#/$defs/targetRow" },
        "sourceLink": { "$ref": "#/$defs/sourceLinkEvidence" },
        "legacyResourceLink": { "$ref": "#/$defs/targetRow" },
        "targetResourceLink": { "$ref": "#/$defs/targetRow" },
        "targetPmsResourceLink": { "$ref": "#/$defs/targetRow" },
        "organization": { "$ref": "#/$defs/targetRow" },
        "bindingClaims": { "$ref": "#/$defs/aggregateEvidence" }
      }
    },
    "approvalSubjectSha256": { "$ref": "#/$defs/sha256" },
    "approvalEvidence": {
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "prefixItems": [
        { "$ref": "#/$defs/approvalEvidence" },
        { "$ref": "#/$defs/approvalEvidence" }
      ],
      "items": false
    },
    "signingKeyId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._:/-]{0,127}$" }
  },
  "$defs": {
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "timestamp": {
      "type": "string",
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
    },
    "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "rowEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["rowOrdinal", "rowChecksumSha256"],
      "properties": {
        "rowOrdinal": { "type": "integer", "minimum": 1 },
        "rowChecksumSha256": { "$ref": "#/$defs/sha256" }
      }
    },
    "hotelEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["rowOrdinal", "rowChecksumSha256", "userId"],
      "properties": {
        "rowOrdinal": { "type": "integer", "minimum": 1 },
        "rowChecksumSha256": { "$ref": "#/$defs/sha256" },
        "userId": { "$ref": "#/$defs/uuid" }
      }
    },
    "aggregateEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["rowCount", "orderedRowsSha256"],
      "properties": {
        "rowCount": { "type": "integer", "minimum": 0 },
        "orderedRowsSha256": { "$ref": "#/$defs/sha256" }
      }
    },
    "targetRow": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "rowStateSha256"],
      "properties": {
        "id": { "$ref": "#/$defs/uuid" },
        "rowStateSha256": { "$ref": "#/$defs/sha256" }
      }
    },
    "sourceLinkEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "rowStateSha256",
        "migrationRunId",
        "migrationPhase",
        "migrationDisposition"
      ],
      "properties": {
        "id": { "$ref": "#/$defs/uuid" },
        "rowStateSha256": { "$ref": "#/$defs/sha256" },
        "migrationRunId": { "type": "string", "pattern": "^vay1351-[0-9a-f]{24}$" },
        "migrationPhase": { "const": "complete" },
        "migrationDisposition": { "const": "canonical" }
      }
    },
    "approvalEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "approvalRecordId",
        "authority",
        "actorUserId",
        "approvedAt",
        "approvalSubjectSha256",
        "registryRevision",
        "rowStateSha256"
      ],
      "properties": {
        "approvalRecordId": { "$ref": "#/$defs/uuid" },
        "authority": { "enum": ["migration_owner", "security_owner"] },
        "actorUserId": { "$ref": "#/$defs/uuid" },
        "approvedAt": { "$ref": "#/$defs/timestamp" },
        "approvalSubjectSha256": { "$ref": "#/$defs/sha256" },
        "registryRevision": { "type": "integer", "minimum": 1 },
        "rowStateSha256": { "$ref": "#/$defs/sha256" }
      }
    }
  }
}
```

The `approvalSubjectSha256` preimage is the ASCII domain prefix
`vayada:channex-property-adoption:v1:approval-subject\0` followed by the RFC
8785 bytes of the complete manifest after removing both
`approvalSubjectSha256` and `approvalEvidence`. Each approval record binds that
hash. The final payload hash is SHA-256 over the ASCII domain prefix
`vayada:channex-property-adoption:v1:payload\0` followed by the RFC 8785 bytes
of the complete manifest, including approvals and `approvalSubjectSha256`.

All other evidence hashes are also domain-separated:

- A staged row checksum is the existing VAY-1351 SHA-256 over the UTF-8 bytes
  of PostgreSQL `row_data::text`; the runner must first recompute it and match
  `row_checksum_sha256`.
- A source `orderedRowsSha256` is SHA-256 over its ASCII domain prefix followed
  by zero or more UTF-8 records of
  `<row_ordinal>|<row_checksum_sha256>\n`, ordered by numeric row ordinal. The
  suffixes are `pms-channex-room-type-mappings`,
  `pms-channex-rate-plan-mappings`, `pms-channex-booking-mappings`, and
  `pms-bookings`, each appended to
  `vayada:channex-property-adoption:v1:` and terminated by `\0`. Single-row
  evidence uses its staged row checksum directly and does not use the aggregate
  hash. The target binding-claim aggregate instead uses the domain
  `vayada:channex-property-adoption:v1:target-binding-claims\0` followed by
  `<lowercase claim UUID>|<rowStateSha256>\n` records ordered by claim UUID.
- A `rowStateSha256` is SHA-256 over
  `vayada:channex-property-adoption:v1:target-row\0` followed by RFC 8785 bytes
  of `{ "schema": string, "table": string, "primaryKey": string,
"row": object }`. `row` contains every physical, non-generated column from
  the deployed schema in `ordinal_position` order. UUID values use lowercase
  text. `timestamptz` values use
  `to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and
  preserve all six PostgreSQL fractional digits; `timestamp` values use the
  same format without timezone conversion, and `date` values use
  `to_char(value, 'YYYY-MM-DD')`. `smallint`, `integer`, `bigint`, `numeric`,
  and `decimal` values are JSON strings produced by PostgreSQL `value::text`
  with no client parsing, rounding, scale removal, or negative-zero rewrite.
  Booleans remain JSON booleans; text remains text; SQL null remains JSON null;
  arrays apply these rules element-by-element; and JSON/JSONB is parsed as
  I-JSON before RFC 8785 canonicalization. The runner rejects non-finite or
  unsupported PostgreSQL values rather than coercing them.
- `sourceEvidenceSha256` is SHA-256 over
  `vayada:channex-property-adoption:v1:source-ledger\0` followed by RFC 8785
  bytes of `{ "run": object, "sources": array, "tables": array }`. `run`
  projects `run_id`, `environment`, `source_schema_revision`,
  `cutover_freeze_proof_sha256`, `status`, and `finished_at`; each source
  projects `source_database`,
  `snapshot_identifier_sha256`, `expected_database_name_sha256`,
  `expected_schema_fingerprint`, `actual_schema_fingerprint`, `status`,
  `row_count`, `checksum_sha256`, and `source_snapshot_at`; each table projects
  `source_database`, `source_schema`, `source_table`, `status`, `row_count`,
  and `checksum_sha256`. The two derived source hashes use the respective
  domains `...:snapshot-identifier\0` and
  `...:expected-database-name\0` followed by the raw UTF-8 string. Source
  timestamps use the six-digit UTC extraction above, and a missing freeze proof
  is represented by JSON null. Sources sort by `source_database`; tables sort
  by `source_database`, `source_schema`, then `source_table`. The projected
  JSON keys are exactly the snake-case names shown here.

The implementation pins one signature algorithm and allowlisted, versioned
verification keys in deployment configuration; neither is selected by the
manifest. Signature material and the SHA-256 of the canonical payload are
stored with the result, never a private key.

The manifest is generated from read-only evidence by the migration tooling,
reviewed by the two named approvers, signed by the controlled deployment
identity, and supplied to the migration runner as an immutable artifact. Manual
editing after signing invalidates it.

The signing identity may sign only after it verifies both approval records.
Names, timestamps, or actor IDs copied into the payload without those bound
records are not approval evidence.

`legacyEvidence` has this exact shape:

- `hotel`: source row ordinal, row checksum SHA-256, and exact `user_id`;
- `connection`: source row ordinal and row checksum SHA-256;
- `roomTypeMappings`, `ratePlanMappings`, `bookingMappings`, and `bookings`:
  row count plus SHA-256 of the ordered `row_ordinal|row_checksum_sha256` list.

`targetEvidence` has this exact shape:

- canonical property ID and row-state SHA-256;
- property source-link ID, state SHA-256, and `migrationRunId`;
- legacy PMS-hotel resource-link ID and row-state SHA-256;
- canonical property ownership resource-link ID and row-state SHA-256;
- PMS property operational resource-link ID and row-state SHA-256;
- target organization ID and row-state SHA-256; and
- row count plus ordered aggregate SHA-256 for every binding claim matching
  either the target property or Channex external property.

Every nested evidence ID must equal its corresponding top-level manifest ID.
The approval array must contain exactly one `migration_owner` followed by one
`security_owner`; duplicate authorities are invalid.

## Evidence rules

The runner must independently reread and verify the manifest evidence before it
writes a claim:

1. The source extraction run exists once, is `completed`, uses the declared
   source environment and schema revision, and has complete, internally
   consistent database and table ledgers. The VAY-1360 pairing is mandatory:
   production targets use `preprod` source evidence; every other target uses a
   source of the same environment.
2. Staged `pms.channex_connections` resolves `externalPropertyId` to exactly one active
   `legacyPmsHotelId`.
3. Every retained `channex_room_type_mappings`,
   `channex_rate_plan_mappings`, and `channex_booking_mappings` row for that
   external property agrees with the same legacy hotel. Each referenced legacy
   booking must have that `hotel_id`.
4. The staged `pms.hotels` row exists once, its `id` and `user_id` match the
   manifest, and its recomputed `row_data::text` checksum matches
   `legacyEvidence.hotel.rowChecksumSha256`.
5. The production identity and catalog plans are recomputed from this source
   run and must finish with zero blockers or warnings. They must resolve staged
   `pms.hotels.id = legacyPmsHotelId` to exactly `targetPropertyId`. The
   complete planned source-link state must equal the declared row: active,
   `source_system = 'pms'`, `source_table = 'hotels'`,
   `source_id = legacyPmsHotelId`, `property_id = targetPropertyId`,
   `relationship = 'operational_input'`, `metadata.migrationRunId =
sourceRunId`, `metadata.migrationPhase = 'complete'`, and
   `metadata.migrationDisposition = 'canonical'`. Its remaining fields and
   metadata must also equal the recomputed plan and signed row-state hash.
6. The declared active legacy resource link must have `product = 'pms'`,
   `resource_type = 'pms_hotel'`, `resource_id = legacyPmsHotelId`, and
   `relationship = 'operator'`. Enumerating the recomputed identity plan must
   yield exactly one active legacy operator organization, and it must resolve
   the staged hotel's migrated owner to `targetOrganizationId`.
7. The organization must be an active `hotel_group`. Its declared canonical
   resource link must have `product = 'hotel_catalog'`,
   `resource_type = 'property'`, `resource_id = targetPropertyId`, and an
   `owner` or `operator` relationship. Enumerating all active canonical
   owner/operator links for the property must produce exactly this one
   organization.
8. The additional operational resource link must be active and have
   `product = 'pms'`, `resource_type = 'pms_property'`,
   `resource_id = targetPropertyId`, the same `targetOrganizationId`, and an
   `owner` or `operator` relationship. It cannot substitute for the canonical
   ownership link in rule 7.
9. The source and target typed evidence recomputed by the runner matches every
   signed count and hash.
10. After resolving exact manifest replay, the VAY-1366 registry has no claim in
    any state for either the target property or the external property, including
    a claim for the same pair.

Webhook receipts and provider audit rows may corroborate the external property
ID, but cannot establish ownership by themselves.

## Verification and consumption

Before persistence, the runner must perform these steps in order:

1. require an allowlisted production migration IAM principal;
2. reject an unknown contract version, signing key, or signature algorithm;
3. verify the detached signature and canonical-payload SHA-256;
4. lock and read manifest consumption by `manifestId` and payload hash; return
   the stored successful result immediately for an exact replay, reject the
   same ID with different bytes and any stored failed result, and only then
   continue with new-consumption validation;
5. require the exact execution environment and an unexpired migration window;
6. validate the immutable source run and every evidence rule above;
7. acquire the same serialized VAY-1366 reservations used by migration,
   enablement, repair, and cutover;
8. recompute target evidence inside the binding transaction; and
9. atomically record manifest consumption, restricted audit evidence, and one
   new `verified_non_active` adoption claim using `INSERT`, never an update or
   upsert.

`manifestId` and canonical-payload SHA-256 are idempotency identities. Exact
replay returns the existing result. Reusing a manifest ID with different bytes,
using the same signed payload for another pair/environment/run, or consuming an
expired or already-failed manifest is rejected.

Immediately before signing and again before consumption, the runner reads two
unrevoked approval records from the protected migration approval registry. One
actor must hold the active `migration_owner` authority and the other the active
`security_owner` authority. They must be different people, and both records
must bind the exact manifest ID, environment, and expiry through
`approvalSubjectSha256`. The signer, either approver, and the execution
principal cannot satisfy another required role. Rollback requires a new pair of
equivalently separated approval records bound to the original manifest and
rollback reason.

## Failure and rollback

Unknown, incomplete, stale, ambiguous, or conflicting evidence fails closed
before a claim is written. This includes:

- a signature, checksum, run, revision, environment, or time-window mismatch;
- missing or duplicate legacy connections, source links, or resource links;
- disagreement between connection, mapping, booking, or organization ownership;
- target property or organization changes after approval;
- any existing claim in any state for either key after exact replay is resolved;
  same-pair history requires a separately reviewed repair/transition command;
  and
- concurrent consumption or payload drift.

A partial transaction creates no claim. If a later rollback is approved, it may
change only the exact `verified_non_active`, `claim_source = 'adoption'` claim
created by this manifest to retained `released` state, and records the reason
and actors. It cannot release or downgrade an active, historical, repair,
migration, or different-manifest claim. Released history never proves that
another target owns the external property.

Rollback does not mutate Channex, remove legacy mappings, replay or acknowledge
bookings, stop polling, or alter webhook routing. The legacy system remains the
only mutating owner until a separate cutover explicitly changes that state.

## Security and audit

- Private signing keys stay in the approved key-management boundary and never
  enter PostgreSQL, source artifacts, CI logs, Linear, or GitHub.
- The runner records manifest ID, signing key ID/version, payload SHA-256,
  signature verification result, source run/revision, exact property and
  organization IDs, evidence hashes/counts, approval record IDs, timestamps,
  pre-state, outcome, and failure reason.
- Audit records use `retention_class = security` and
  `privacy_scope = restricted` for seven years.
- No provider credential, guest data, reservation payload, or raw source row is
  copied into the manifest or audit event.
- The approval registry independently authorizes active migration/security
  actors and retains its revisions; manifest content cannot grant authority.

Legacy scheduler status is not ownership proof for adoption and is not copied
into the manifest. Adoption changes no runtime owner. The separate cutover must
use its trusted, time-bound scheduler/deployment evidence to prove legacy
polling is frozen before target booking mutation starts.

## Acceptance criteria for implementation

- The manifest uses RFC 8785 canonicalization, the exact typed nested schemas
  above, and rejects unknown or duplicate fields and non-canonical values.
- Signature verification uses a pinned algorithm and allowlisted versioned
  verification key; tampering any field fails.
- Only the approved migration runner can consume a manifest; ordinary PMS
  routes and hotel users cannot invoke adoption.
- Source-run completeness, legacy ownership, canonical source link, target
  organization/resource ownership, and all evidence counts and hashes are
  reread rather than trusted from the payload.
- Unknown or conflicting history fails closed.
- Existing same-pair or cross-pair claim history is never updated by adoption;
  only exact consumption replay succeeds.
- Concurrent attempts cannot reserve one target property or Channex external
  property for different pairs.
- Exact replay is idempotent and payload drift conflicts.
- Success creates only a `verified_non_active` claim with restricted audit
  evidence.
- No target connection becomes active, no provider call or job is made, and
  legacy polling/webhook/booking ownership remains unchanged.
- Tests cover valid consumption, each evidence mismatch, expiry, environment
  mismatch, signature/key/version failure, duplicate/unknown JSON fields,
  canonicalization edge cases, tampering, approval authority/revocation and
  separation of duties, replay, same-pair/cross-pair history, payload drift,
  concurrency, transaction failure, rollback isolation, and non-mutation of
  provider and ownership state.

## Execution gate

No production manifest is authorized by this decision alone. Execution requires
an implementation ticket, security review of the signing-key boundary, a
read-only generated manifest for the exact production pair, named approvers,
and the normal cutover approval. Synthetic fixtures may validate the contract
in staging but cannot authorize a production pair.

The sanctioned staging regression pair is target property
`65f6b2fc-c783-4963-9d6b-a85f82319769` and Channex property
`8f4c1e47-3de1-4150-8bde-ad031a013842`. It is already bound and remains
observe-only, so it validates exact identity resolution, existing-claim
rejection, and non-mutation. The successful-adoption path must use a generated,
isolated migration fixture; this pair must not be released or rebound to make a
test pass.
