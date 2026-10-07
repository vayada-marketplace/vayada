# Coordinated next release publishing

Status: implementation-ready and activation-gated by VAY-2029.

This repository produces complete immutable release manifests for the six
managed `next-*` services. The platform repository consumes those manifests;
publication never mutates ECS. The executable v1 schemas and cross-repository
fixtures live in [`deployment-contract`](deployment-contract/).

## Activation boundary

Both coordinated workflows require the repository variable
`COORDINATED_RELEASES_ENABLED=true`. The six legacy `deploy-next-*` automatic jobs skip when that variable is true;
their explicit `workflow_dispatch` build entrypoints remain available. Setting
the variable switches all six automatic builders together. It does not grant
platform mutation ownership, resolve holds, or drain previously started jobs. VAY-2029 installs and
validates the platform receiver first, inventories and drains old events, then
switches all six automatic lanes together. Existing per-service
`workflow_dispatch` entrypoints remain available during preparation.

Once activated, `Build coordinated next release` is the only automatic builder
for these services. Its non-canceling `coordinated-next-release-main`
concurrency group leaves a running build pinned to its source SHA while GitHub
retains only the newest waiting request. The waiting request still compares to
the previous complete published manifest, so intermediate failed, canceled, or
replaced requests remain included in the cumulative diff.

## Managed services

The allowlist is executable at
[`deployment/coordinated-release/services.json`](../deployment/coordinated-release/services.json).

| Service key                 | Application            | ECR repository                       |
| --------------------------- | ---------------------- | ------------------------------------ |
| `next-target-backend`       | `apps/api`             | `vayada-next-api`                    |
| `next-pms-frontend`         | `apps/pms-web`         | `vayada-next-pms-frontend`           |
| `next-booking-frontend`     | `apps/booking-web`     | `vayada-next-booking-frontend`       |
| `next-booking-admin`        | `apps/booking-admin`   | `vayada-next-booking-admin-frontend` |
| `next-marketplace-frontend` | `apps/marketplace-web` | `vayada-next-marketplace-frontend`   |
| `next-marketplace-admin`    | `apps/vayada-admin`    | `vayada-next-admin-frontend`         |

The build preserves each current Dockerfile, build argument, production flag,
and per-service cache scope. It continues to write convenience `next-latest`
tags, but manifests and platform reconciliation use only verified
`sha256:<digest>` identities. A mutable tag is never a release identity.

## Cumulative affected-input selection

Selection compares the pinned source with the ancestry-newest, non-expired,
hash-valid complete published manifest. Candidate ordering is by Git ancestry,
not artifact timestamps. A baseline that is missing, expired, malformed,
divergent, or unavailable locally causes all six services to rebuild.

The selector evaluates workspace dependencies at both revisions. This preserves
the old consumer when a dependency is removed and adds the new consumer when a
dependency is introduced. It includes renamed and deleted paths, the root npm
manifests and lockfile, TypeScript configuration, `.dockerignore`, service
Dockerfiles, the API migration workspace and its transitive inputs, the API
startup script, and copied replay fixtures. An unknown path under `packages/`
or the coordinated release pipeline selects all services rather than claiming
that nothing is affected.

## Manifest and publication identity

`manifest.json` contains exactly:

- schema version, trusted repository, immutable main source SHA;
- allowlisted build workflow name/path, successful run ID and attempt;
- prior complete manifest ID and source SHA, or both `null` for bootstrap;
- the v1 ordinary compatibility declaration;
- inherited typed barriers;
- exactly six service entries with approved ECR repository, digest, and the
  source SHA that built that image.

`manifestId` is
`vayada-release/v1/<sourceSha>/<buildRunId>/<buildRunAttempt>`. The detached
`manifest.sha256` binds the JSON bytes. A changed service records the current
source SHA; an unchanged service carries the already verified digest and image
source SHA from the baseline.

The build uploads
`next-release-candidate-v1-<runId>-<runAttempt>` for 14 days only after all
affected image builds and the full six-service ECR verification succeed. Each
`next-<imageSourceSha>` tag must still resolve to its recorded digest. Failed or
partial matrix runs therefore have no complete candidate and cannot advance the
baseline.

The separate `workflow_run` publisher accepts only the named, completed,
successful main build workflow from `vayada-marketplace/vayada`, and pins its
source SHA, run ID, run attempt, candidate artifact ID/name, and manifest hash.
It checks out publisher code from trusted `main`; it never executes code from a
downloaded artifact. After reverifying every ECR digest and source-tag binding,
it uploads
`next-release-published-v1-<sourceSha>-<runId>-<runAttempt>` for 90 days with:

- the identical manifest and detached hash;
- `published-record.json` and its detached hash;
- producer and publisher workflow provenance;
- candidate artifact identity, publication/expiry timestamps, and
  `idempotencyKey = manifestId`.

The published artifact cannot contain its own GitHub artifact ID. The dispatch
therefore binds the actual ID and publisher run metadata alongside both content
hashes. The platform must verify those values against GitHub before mutation.
Expired or deleted records are ineligible; recovery requires a complete rebuild.

## Dispatch and access

The publisher sends `coordinated-release-published` to
`vayada-marketplace/vayada-platform`. Its compact payload contains the schema
version, manifest ID/hash, publication-record hash, source SHA, producer
repository/workflow/run/attempt, published artifact ID/name, publisher
run/attempt, and idempotency key. Duplicate dispatch of one manifest is
deliberately safe.

`PLATFORM_DEPLOY_TOKEN` in this repository needs only permission to create the
platform repository dispatch. The platform receiver separately needs read
access to this private repository's Actions artifacts and workflow metadata.
Neither token belongs in an artifact or log. The application OIDC role needs ECR
push/read but no ECS mutation permission.

## Release barriers

Exceptional migrations, backfills, or required application checkpoints are
append-only JSON declarations under
`deployment/coordinated-release/barriers/<id>.json` with exactly:

```json
{
  "id": "example-checkpoint",
  "kind": "application",
  "requiredCheckpointManifestId": null,
  "evidenceRequirement": "Operator acknowledgment with the verification run URL"
}
```

The planner derives `introducedAt` from the commit that added the declaration.
It scans cumulative history, including commits whose waiting workflow was later
coalesced. Deleting, renaming, mutating, or adding unknown fields fails closed.
Every later manifest inherits the barrier. The platform owns acknowledgment and
evidence state; neither SQL filenames nor a successful image build satisfy it.

## Recovery and redispatch

List non-expired durable records:

```bash
gh api --paginate repos/vayada-marketplace/vayada/actions/artifacts \
  --jq '.artifacts[] | select(.expired == false and (.name | startswith("next-release-published-v1-"))) | [.id, .name, .expires_at] | @tsv'
```

If a publication already exists, start a **fresh manual run on main** with its
non-expired artifact ID to redispatch without rebuilding:

```bash
gh workflow run publish-coordinated-release.yml \
  --repo vayada-marketplace/vayada \
  --ref main \
  -f published_artifact_id=<artifact-id>
```

The recovery run verifies artifact metadata, both hashes, expiry, publisher
provenance, all six ECR digest/source-tag bindings, and then sends the same
manifest ID and idempotency key. It cannot substitute a rerun's candidate
artifact. Source validation, redispatch, and baseline discovery fetch the exact
recorded run attempt; a later rerun does not invalidate historical provenance.

Rerunning an original publisher with an existing publication is rejected before
candidate download or upload, with the existing artifact ID and redispatch
instructions. No artifact is overwritten or deleted. A rerun before any durable
publication exists can still publish. With `COORDINATED_RELEASES_ENABLED` off,
the fresh manual publisher still verifies the artifact and images but does not
send a platform dispatch; enabling delivery remains a separate approved action.

If the durable record expired or its contents cannot be verified, run the
manual build entrypoint at current `main`; the missing baseline deliberately
rebuilds all six services:

```bash
gh workflow run build-coordinated-release.yml \
  --repo vayada-marketplace/vayada \
  --ref main
```

A dispatch failure does not delete the 90-day record. A green build means only
that a complete candidate exists; a green publisher means published and
dispatched, never deployed. Because upload precedes dispatch, a completed
publisher run that failed only after uploading remains an eligible baseline and
redispatch source. Platform reconciliation and deployed acceptance are separate
VAY-2028/VAY-2029 evidence.

## Publication retention

`publishedAt` marks the start of the publication workflow: the GitHub run's
`created_at`, including on a retry. `expiresAt` is exactly 90 days later.
Using the later upload-step wall clock would overstate artifact retention;
GitHub's observed expiry is based on the workflow run's earlier timestamp.
After upload (and before redispatch), the publisher checks the actual artifact
is not expired and its `expires_at` covers the record's promised expiry. A
shorter retention fails closed; the receiver retains its independent check.

An already-published record is immutable. A record with an overstated expiry
requires a new preparation/publication, not an edited artifact or weaker
receiver expiry validation.

## Local validation

```bash
npm run test:coordinated-release
node scripts/coordinated-release/validate.mjs manifest \
  engineering/deployment-contract/fixtures/manifest-v1.valid.json
```

The valid manifest and publication record are byte-for-byte shared protocol
fixtures with the platform repository. Invalid fixtures prove fail-closed trust
checks.
