# Hotel import MVP review record

Checked 2026-09-10. This is local test evidence, not deployed acceptance.

## What can be demonstrated

| Part                                                 | Evidence                                                                            | Limit                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Connection, cancel, empty account, listing selection | Standalone browser simulator                                                        | Synthetic approval and listings; no Airbnb OAuth                                      |
| Edit, select and save room facts                     | Shared editor with production import routes and isolated PostgreSQL                 | Synthetic identity and invitation-prepared source                                     |
| Persistence and duplicate prevention                 | Database save/reload and concurrent replay checks                                   | Local database; not a fresh host connection                                           |
| Onboarding to PMS room settings                      | Actual product pages save and read the same local records                           | Auth and unrelated setup APIs are mocked                                              |
| Adaptive onboarding refresh                          | Browser success/lost-response cases preserve local edits                            | Room APIs mocked                                                                      |
| Earlier onboarding refresh                           | Browser success/failed-refresh cases retain unfinished input for reference          | Room APIs mocked; retained input is not a persistent draft                            |
| Room settings read recovery                          | Actual PMS page retries an induced outage against the local database without writes | Post-import failure has separate unit coverage                                        |
| Invitation acceptance                                | Owned by the separate invite-code task                                              | The database harness starts with an accepted invitation; it does not prove redemption |

The real Channex checks recorded in [README.md](README.md) established that a
staging connection link could open Airbnb login and that an already connected
Aether listing could be read. They did not establish fresh host authorization.

## Review order

The shared import foundation (#1841) and prerequisite handoff (#1805) are merged.
These eight MVP PRs remain draft and open, in dependency order:

1. [#1872](https://github.com/vayada-marketplace/vayada/pull/1872): simulator fixtures, based on main.
2. [#1873](https://github.com/vayada-marketplace/vayada/pull/1873): simulated connection and review UI.
3. [#1886](https://github.com/vayada-marketplace/vayada/pull/1886): isolated database API harness.
4. [#1887](https://github.com/vayada-marketplace/vayada/pull/1887): shared editor with real local saves.
5. [#1891](https://github.com/vayada-marketplace/vayada/pull/1891): actual onboarding and PMS pages.
6. [#1895](https://github.com/vayada-marketplace/vayada/pull/1895): adaptive room refresh.
7. [#1901](https://github.com/vayada-marketplace/vayada/pull/1901): earlier room-form refresh.
8. [#1904](https://github.com/vayada-marketplace/vayada/pull/1904): room-settings read recovery.

The stack was rebased onto main `f72dc2bff` after the foundation merged. All eight
patches were unchanged by the rebase. The first PR now contains only its three
fixture files (190 added lines), rather than inherited foundation changes.
Focused post-rebase verification passed: 44 Marketplace tests, 10 PMS tests,
eight onboarding browser checks, and Marketplace/PMS/harness typechecks.
Earlier per-slice build and review evidence remains in the PR descriptions.

## Local review

- [Standalone simulator](https://pms.localhost:1379): synthetic connection and failure scenarios; reset affects only its session storage.
- [Database demo](https://pms.localhost:1380/database.html): shared editor and persisted synthetic room types. Already saved items remain saved.
- [Product-page reproduction](PRODUCT-PAGES.md): automated browser context supplies authentication fixtures; opening the product URLs directly still requires login.

Use [DATABASE.md](DATABASE.md) for the dedicated database procedure. Do not reset
shared databases or treat a room type as physical stock, pricing or publication.

## Connection lifecycle follow-up

The stack now adds the read-only listing adapter (#1909), scoped source storage
(#1911), authenticated unmounted routes (#1913), and connection-link transport
(#1914). The browser-return slice adds token scrubbing, session recovery, cancellation
and saved-source recovery. Eight browser scenarios pass with synthetic API/auth
responses; the link/route/reader suite has 58 passing tests. See
[the source design](../../engineering/airbnb-onboarding-source.md) for contracts.

## Airbnb application receipts

A separate internal receipt repository now records completed Airbnb source items
without invitation rows. The local migration 0180 was applied and its rerun was
a no-op. The focused suite passes 74 tests, including 16 real PostgreSQL source/
receipt tests. Concurrent mixed-case source IDs share one lock; successful receipts
persist across reopening, failed items remain retryable, and exact actor/organization/
property/source scope is required. Executors are synthetic; no canonical room
commands are wired to this repository yet.

## Remaining boundary

The callback is disabled by default, and provider routes are not mounted. Next:
resolve trusted account/property bindings, redact initial callback request logs,
and connect saved Airbnb sources to shared review/application. The current room
application contract still uses invitation-prepared data. A full fresh-host
authorization remains unverified; synthetic tests do not close that gap. No live
provider write or deployment was performed for these connection lifecycle slices.

Follow-up: the [Airbnb source slice](../../engineering/airbnb-onboarding-source.md)
adds an unmounted read-only adapter for channel scope checks, listing names and
capacity. Its tests use synthetic provider responses. Detailed room facts and
shared-review wiring are separate slices.
This storage slice adds hashed, expiring connection state and immutable source
snapshots, checked with eight real local PostgreSQL tests. It remains unmounted;
authenticated connection routes, save receipts and shared-review wiring are still pending.

The following route slice adds an isolated authenticated start/complete/source-read
plugin with synthetic provider ports. It is not registered in the running app.
Production binding/link ports, callback UI, save receipts and live wiring remain pending.

Do not infer deployment from a merged foundation PR. This record does not verify
the running remote revision, invite redemption or a complete launch-ready hotel.
