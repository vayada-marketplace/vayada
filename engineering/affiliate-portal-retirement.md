# Affiliate portal source retirement

VAY-1498 and VAY-1499, based on the accepted
[VAY-1497 inventory](https://linear.app/vayadacom/document/affiliate-retirement-inventory-and-continuity-plan-vay-1497-2135f92ca34e).

## Source removal is separate from service cutover

Stop publishing new standalone affiliate images before deleting the application.
The existing deployed portal remains the temporary continuity surface while the
integrated Marketplace product is built. Removing a GitHub build workflow does
not stop ECS, change DNS, move users, or retire an API.

Marketplace currently accepts creator_workspace and hotel_group organizations;
it does not accept affiliate_partner. Do not replace the affiliate login with a
Marketplace redirect until an accepted, verified existing-user path exists.
Do not manufacture creator memberships for affiliate-only accounts. VAY-2209
replaces these continuity rules under one condition; see its section below.

Keep the deployed portal's auth, reporting, payout-settings and payout-history
API contracts during source removal. VAY-1499 and VAY-1500 must retain these
consumers until cutover. Old hotel booking-domain ?ref URLs are separate from
portal URLs and remain supported by Booking. Preserve identity records,
referral evidence, commission rules, balances, payout evidence and provider IDs.

## Observed deployment baseline

Read-only inspection on 2026-09-06, eu-west-1, cluster
vayada-backend-cluster:

| Service                                 | Task definition                    | State                                        |
| --------------------------------------- | ---------------------------------- | -------------------------------------------- |
| vayada-affiliate-dashboard-service      | vayada-affiliate-dashboard:99      | ACTIVE, desired/running 1, rollout COMPLETED |
| vayada-next-affiliate-dashboard-service | vayada-next-affiliate-dashboard:19 | ACTIVE, desired/running 1, rollout COMPLETED |

The next task definition pins this image digest:

```text
vayada-next-affiliate-dashboard@sha256:96fce14b8754ea70c9af881405fc3c69711d69d7f4c39f11b71db4d316403088
```

ECR retains it with the release tag
next-a2bdf3b38d1dda4af27d41af9ecdf7441e0a8ae4. The inspected next repository
lifecycle policy expires only untagged images after seven days; keep the release
tag. Do not use next-latest as the recovery reference.

The canonical task definition references
vayada-affiliate-dashboard:e3809df436514fc14df84f0adf14f365856fea2c.
It is not changed by this work.

Both https://affiliate.vayada.com/login and
https://next-affiliate.vayada.com/login returned HTTP 200. This proves page
availability only; it does not prove authenticated access, correct balances,
booking attribution or payout execution. These observations are a timestamped
baseline, not a permanent assertion about the deployed state.

## Delivery sequence

1. Remove the application-repo next portal build/deploy workflow. Keep source and
   auth/API tests in this prerequisite change. Check for an already-running build
   or platform dispatch before declaring delivery frozen; workflow deletion does
   not cancel a queued or in-flight run.
2. Remove the old app source, exclusive tests, workspace entries and local
   tooling references in the next source-only change. Keep the tagged deployed
   image and runtime/API contracts. No platform infrastructure changes accompany
   source deletion.
3. Build and verify the integrated account/earnings destination. Inventory real
   owner mappings, active links, financial obligations and provider/queue state
   before any user or API cutover. Preserve quarantine and multi-currency totals.
4. Coordinate the separately reviewed platform redirect/callback/service cutover.
   Only retire the retained API contracts and service after existing-user,
   referral and Finance continuity checks pass.

## Recovery and completion

Before a cutover, source deletion requires no runtime rollback because it does
not change a deployed service. Preserve the current task definition and tagged
image so task replacement does not depend on rebuilding the deleted app.
Recheck artifact retention and service configuration before each later cutover.
If an API change would break the retained portal, stop that release and keep its
compatible API version; never silently move users to an inaccessible destination.

A failure in the eventual integrated destination rolls back its narrow adapter
or routing change with a reviewed recovery artifact. Do not replay payouts,
change provider ownership or downgrade schemas as an automatic rollback step.

Source removal alone does not complete VAY-1498's existing-user continuity
acceptance criterion. Keep the issue open until the accepted destination and
required verification are delivered. Do not report a build freeze, HTTP 200 or
mocked tests as a complete affiliate migration.

## Current source retirement state (VAY-1499)

This section describes the stacked implementation through PR #1688 and this cleanup.
It is not a claim that the stack is merged, deployed or accepted. Source removal and
service/account cutover remain separate, as described above.

### Removed product behavior

Booking Web no longer offers public enrolment. Its ReferModal, exclusive API client,
registration/email-existence repository methods and obsolete projection tests are removed.
Booking Admin `/affiliates` keeps an unavailable notice and dashboard link inside the
existing authenticated shell. Its old workspace, client, sidebar/search entry and
lifecycle/commission UI are removed. The shared Feature Hub catalog no longer advertises
or offers activation of the old affiliate module in Booking Admin or PMS.

The target API retains explicit HTTP 410 responses with `Cache-Control: no-store`:

| Surface          | Retired routes                                                                                                             | Error code                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Public enrolment | GET `/api/booking-web/hotels/:slug/affiliates/check-email`; POST `/api/booking-web/hotels/:slug/affiliates`                | `affiliate_enrollment_retired`        |
| Module changes   | PATCH `/api/pms/properties/:propertyId/module-activations/:moduleId` for the known affiliate module and valid request body | `affiliate_module_activation_retired` |
| Administration   | GET `/api/marketplace/properties/:propertyId/affiliates`; GET detail and POST `/:affiliateId/lifecycle`                    | `affiliate_administration_retired`    |

Existing authorization, property scope, CORS and applicable request validation remain
before the protected retirement responses. Public enrolment is retired wherever its
routes are mounted, including the fallback adapter. Missing configuration remains
fail-closed. Retired administration routes do not read affiliate data or mutate state.

Unused lifecycle and module-activation writers, their obsolete tests, listing SQL/query
parser and exclusive action/command/result/list-input/endpoint exports are removed.
The module route no longer receives a publication-refresh port; other booking consumers
retain their refresh wiring.

### Retained continuity

- Booking `?ref=` cookie/click capture, quote attribution and reservation history remain.
  These paths prove capture/storage, not verified completed-booking attribution.
- Existing-affiliate Connect remains scoped to existing registration evidence. Shared
  provider handling, identity derivation, callbacks and historical events are unchanged.
- Module inventory advertises no supported modules but still reads existing scoped
  activation state. No activation rows or earning agreements are deactivated by cleanup.
- The admin-named repository retains `getAffiliate(propertyId, affiliateId)` for shared
  Finance and its existing close hook. Its record/status types remain required by that
  consumer; old administration reads return 410 independently.
- Portal auth/account and payout settings/history APIs remain for the frozen service.
  The server does not supply the optional dashboard reporting repository; guarded
  unavailable responses are not proof of working deployed reporting.
- Collaboration approval still reports affiliate provisioning requests for enabled terms.
  Response/evidence contracts alone do not prove actual provisioning. Preserve collaboration
  data and trace this behavior through the integrated M1 design before changing it.
- Finance commission configuration, payout operations, fee settings and shared dispatcher
  code remain subject to VAY-1500 reconciliation. No normal affiliate dispatcher caller
  was found in searched source; deployed scheduler/queue/provider ownership is unverified.

Identity records, quarantine, referral evidence, historical lifecycle/audit rows, commission
rules, balances, provider references, payment evidence and applied migrations remain intact.
Python services and platform infrastructure are outside this source cleanup.

### Verification and remaining release work

Per-slice unit/build/browser evidence is recorded in VAY-1499 and the stacked PRs.
Mocked checks and skipped PostgreSQL integration tests do not establish live continuity.
Before completion, integrate reviewed PRs in order, verify the deployed revision and
exercise returning-user access, callbacks, old links through persisted booking evidence,
and unchanged balances/history using bounded synthetic data. No real reservations or
payments belong in smoke testing.

The integrated account destination and service cutover remain VAY-1498 work; conditional
Finance cleanup remains VAY-1500 work. Keep VAY-1499 In Progress until required validation
and explicit acceptance are complete. Do not delete the retained continuity boundary
merely because the standalone source has been removed.

## VAY-2209 production address and portal shutdown (2026-10-15)

Flamur's decision, recorded on VAY-2209:

- No standalone affiliate app runs in production. Creators use Marketplace
  (`/earnings` and the collaboration agreement panel); hotels use their Marketplace
  profile.
- `affiliate.vayada.com` stays as the public affiliate address with two jobs:
  a redirect to Marketplace earnings, and later the stable host for
  creator share links (`https://affiliate.vayada.com/r/va_…`). Shared links then
  never depend on the API host's name.
- `next-affiliate.vayada.com` is removed.
- This decision replaces the rules above about keeping the portal, its redirect and
  its continuity APIs, **only while** the legacy PMS database shows no approved
  affiliate with a scheduled affiliate payout. If one exists, the old portal stays up
  until those payouts are settled.

### What runs today (read-only check, 2026-10-15)

| Host                        | Load balancer rule (`vayada-backend-alb`, 443) | ECS service                               | Talks to                                        |
| --------------------------- | ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `affiliate.vayada.com`      | priority 45 → `affiliate-dashboard-tg`         | `vayada-affiliate-dashboard-service`      | legacy `pms-api` and `booking-api` (Python)     |
| `next-affiliate.vayada.com` | priority 56 → `next-affiliate-tg`              | `vayada-next-affiliate-dashboard-service` | `next-api` (auth surface `affiliate-dashboard`) |

Both run the deleted `apps/affiliate-dashboard` image (see the baseline above). Public
DNS is Cloudflare: its `next-affiliate` record is in platform Terraform, its `affiliate`
record is managed by hand. Both Route 53 records are in Terraform. The `*.vayada.com`
certificate covers both hosts, so no certificate work is needed.

In the 30 days to 2026-10-14 neither portal's dashboard was used: legacy `pms-api` got
no `/affiliate/*` call and `next-api` no `/affiliate/*` contract call. The load balancer
counted 1,723 and 213 requests, almost all sign-in pages. The `next-api` sign-in calls
on the affiliate surface (69 session checks, 66 Google starts, never followed by a
dashboard call) match the platform's own auth-gateway probes. No `/r` link or `?ref`
click arrived either.

The legacy PMS service still runs its monthly `process_affiliate_payouts` job, and old
`?ref` links still create scheduled affiliate payouts for attributed bookings. That is
why the payout count is re-checked before every step that removes something.

Links that may still exist: legacy invite emails
(`https://affiliate.vayada.com/set-password?token=…`), login bookmarks on both hosts,
and the next portal's sign-in settings (`AUTH_AFFILIATE_DASHBOARD_*` on `next-api`, and
one WorkOS production redirect URI, `https://next-affiliate.vayada.com/auth/oauth/google/callback`). Old `{slug}.booking.vayada.com?ref=` links live on the booking
host and are not affected.

### Cutover runbook

Steps 2, 4 and 6 are `vayada-platform` Terraform changes, reviewed and applied by the
coordinator or Flamur. Step 5 is application code.

1. **Check:** legacy PMS counts of affiliates by status and of affiliate payouts by
   status (read-only). Continue only if no approved affiliate has a scheduled payout.
   On 2026-10-15: 90 affiliates (32 approved) and no affiliate payout ever, in any status.
2. **Redirect** ([vayada-platform#538](https://github.com/vayada-marketplace/vayada-platform/pull/538)):
   - rules 45 and 56 change from forward to a temporary `302` to
     `https://next-marketplace.vayada.com/earnings`, dropping the query so a legacy
     `set-password` token is never forwarded;
   - a new rule 47 keeps `next-affiliate.vayada.com/auth/*` forwarding to its service.
     `tf-apply` probes every gateway in `auth-gateways.json` after each apply and fails
     on a redirect, so the next portal's gateway stays reachable until step 6.
3. **Verify:** `curl -sI` on `/`, `/login` and `/set-password?token=x` for both hosts
   returns `302` with `location` exactly the earnings URL (no `?`).
   `next-affiliate.vayada.com/auth/session?surface=affiliate-dashboard` still returns
   `401`. A fresh `terraform plan` shows no changes. Then, manually in the WorkOS
   production environment (coordinator, with Flamur's go), remove next-affiliate's only
   redirect URI, `https://next-affiliate.vayada.com/auth/oauth/google/callback`. The
   gateway probe only checks that Google start answers `302` to WorkOS; it does not
   follow it.
4. **Scale the old portal to 0:** re-run the step 1 count, then set
   `desired_count = 0` on `affiliate-dashboard` in `infra/ecs.tf`. A CLI scale-down is
   reverted by the next apply. Its target group is no longer attached, so a
   replacement task could not register anyway.
5. **Code:** remove the `affiliate-dashboard` auth surface (today
   `AUTH_AFFILIATE_DASHBOARD_ORIGIN` is required whenever auth is configured), the
   `/affiliate/*` continuity contract and the legacy affiliate JWT setting from
   `apps/api`. Release it before step 6, or `next-api` fails its config check.
6. **After 30 days, delete** (re-run the step 1 count first):
   - the `next-affiliate-dashboard` entry in `auth-gateways.json` and its expected
     origins, `next-api`'s `AUTH_AFFILIATE_DASHBOARD_*` and the
     `AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET` mapping (keep the shared JWT parameter
     itself), and rule 47;
   - both ECS services and task definitions, the two target groups, log groups,
     `ecr_repo_map` entries and the `deploy.yml` service cases;
   - the two ECR repositories, after emptying them (`force_delete = false`);
   - the `next-affiliate` Route 53 and Cloudflare records.

   Keep the `affiliate` DNS records, rule 45 and the certificate.

Rollback for steps 2–4: revert the platform change(s); both task definitions and tagged
images stay until step 6.

The redirect is a `302`, not a `301`: browsers cache a `301` indefinitely, the target
is a temporary `next-*` host, and `affiliate.vayada.com` will later serve `/r/*` share
links. When Marketplace moves to its final host, re-point rules 45/56.

Step 4 is [vayada-platform#543](https://github.com/vayada-marketplace/vayada-platform/pull/543)
and covers only the old portal. `vayada-next-affiliate-dashboard-service` stays at 1
until step 6: the auth-gateway probe reaches `/auth/*` through that app, which proxies
to `next-api`, so with no task the probe gets a `503` and the apply fails.

### Share links on affiliate.vayada.com

Creator share links are not live in production: `next-api` does not mount `/r`
(`AFFILIATE_CAPTURE_ENABLED` and `AFFILIATE_PUBLIC_REDIRECT_ENABLED` are unset) and
Booking Web arrival is off. To switch them on:

1. Make the booking host checks configurable: `/r` and the arrival transport still only
   accept `*.next-booking.vayada.com` destinations.
2. Add a load balancer rule above rule 45: host `affiliate.vayada.com` and path `/r/*`
   → the `next-api` target group, and turn on `/r` and capture in `next-api`.
3. Only then build Marketplace Web with
   `NEXT_PUBLIC_AFFILIATE_LINK_ORIGIN=https://affiliate.vayada.com`. Pass it as a
   build argument in `deploy-next-marketplace-web.yml` and `build-coordinated-release.yml`
   (the Dockerfile declares it). Without it, links fall back to the API host. Links
   printed before step 2 would hit the cached earnings redirect.

## VAY-1500 commission configuration retirement

The user confirms no real customers use the new TypeScript system and authorizes
its affiliate cleanup. Real-customer link/balance fixtures are not a prerequisite
for this source retirement; preserve stored records and shared Finance.

Property default and individual affiliate commission GET/PATCH routes now return
410/no-store after the existing property Finance authorization checks. They do not
read or write commission rules or look up affiliate records. The authorization
fallback still reads Booking Finance access. Old commission writer/contracts will
be removed in a separate slice. Shared payouts, jobs, history and Python are unchanged.

VAY-1500 follow-up removes the obsolete commission writer integration suite and
exclusive affiliate-scope/clock wiring. Retirement tests retain throwing read/write
probes; shared Finance and dispatcher tests remain. The route now depends only on
Booking Finance access and pool cleanup. Writer removal follows separately.

The unused commission reader/writer and its command/view/result exports are now
removed. The remaining repository only reads Booking Finance access and closes
its pool; it cannot change commission rules, balances, audit or payment evidence.

## VAY-1500 affiliate dispatch retirement

The unused affiliate payout runner and its exclusive provider port, result types
and unit-test fixtures are removed. A source search across apps, packages, scripts
and workflows found no application caller; the removed tests were its only callers.
This follows the user's authorization to clean up the customer-free TypeScript
system. It does not establish the absence of external jobs or stored obligations.

The PostgreSQL affiliate store remains for a separate cleanup slice. Shared property
dispatch, provider attempts, historical queue keys, platform payout operations and
manual mark-paid guards remain unchanged. No job is replayed, record deleted or
provider ownership changed.

The next slice removes the unused affiliate PostgreSQL store factory, candidate
query and exclusive store/row types and normalizers. No application callers remain.
Its private mutation helpers are removed separately; shared property SQL, platform
payout read/mark-paid paths and stored evidence remain unchanged.

The final dispatcher slice removes private affiliate claim/success/failure and
notification-audit writers, their job-update helper and exclusive candidate/context/
mutation types and job-key exports. Shared property dispatch and provider-attempt
evidence encoding remain intact, including nullable historical affiliate metadata.
Platform manual mark-paid still checks the historical affiliate queue directly;
this cleanup neither deletes queued records nor releases in-flight payment guards.

## VAY-1500 affiliate fee-split retirement

The next bounded change removes the obsolete affiliate argument, affiliate commission
result and affiliate-only fee branch from the pure calculatePayoutSplit contract.
Source search found only tests calling this helper. It retains the shared property
calculation: fixed plans charge zero platform fee; commission plans use the direct
booking or channel-manager rate, with existing rounding and validation.

BillingConfigReadModel, stored affiliate fee metadata, Booking checkout snapshots,
migrations, payout history and operational Finance APIs remain unchanged. Their
retained fields are financial evidence, not authorization to calculate new affiliate
commissions using the retired product rules. New earning calculations belong to the
accepted Marketplace affiliate agreement/booking/commission design.
