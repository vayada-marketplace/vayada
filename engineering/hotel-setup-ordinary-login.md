# Hotel setup on the ordinary API login (VAY-2056)

_Design note and implementation plan, 2026-10-07. Phase 1 deliverable; nothing in
this document grants, deploys or decommissions anything. Predecessors:
[API runtime database role](api-runtime-database-role.md) (VAY-2054),
[credential lifecycle](hotel-setup-command-credential-lifecycle.md),
[launch settings](hotel-setup-launch-settings-command.md),
[logo writer](hotel-setup-logo-writer.md),
[profile-edit writer](hotel-setup-profile-edit-writer.md),
[automatic provisioning](hotel-setup-automatic-provisioning.md)._

## Decision in one paragraph

After VAY-2054 the login `vayada_next_api_runtime` (`TARGET_DATABASE_URL`) has
ordinary DML on every product table these six Owner operations write, plus the
identity product-link column matrix the creation and Feature Hub writers need.
Every hotel-setup row-level-security guard and every hotel-setup trigger either
exempts non-native logins explicitly or runs as `SECURITY DEFINER`, so the
ordinary login can execute all six operations with **no migration, no new grant
and no `SECURITY DEFINER` EXECUTE exception**. The ticket's premise that the
definer checks "do not depend on which login calls them" is wrong for every
hotel-setup definer function: each one derives its authority from `session_user`
or from a `platform.hotel_setup_*_scopes` row keyed on the native login
(§3). They are therefore not reusable from the ordinary login and must not be
rewritten (they are hash-pinned by the running native services, §4). The plan
moves the in-transaction Owner re-check, idempotency, revision CAS, audit and
contact-privacy behaviour into ordinary application SQL that already exists for
the pre-cutover writers, re-checks current Owner authority inside each write
transaction behind one shared scope wrapper and the login-independent helpers the
native commands already use (§5), and makes the public API stop reading the four
`HOTEL_SETUP_*_COMMAND_*` admission variables. Release is one ordinary API image;
rollback is the previous image, within the window §9 defines. The explicit
`runtimeDefinerFunctions` allowlist asked for in the brief is therefore **empty**
and recorded without a new mechanism (§7, decision 1).

## 1. Owner operations still on native logins (inventory)

Forwarding is decided per purpose in `apps/api/src/server.ts` (lines 340–357)
and `apps/api/src/app.ts` (796–798, 817, 1028, 1089). Production renders all
four admissions `enabled` (platform `infra/hotel_setup_staging.auto.tfvars`).

| #   | Owner operation               | Public route                                                                                                                                                                          | Forwarder op / env prefix                                                                                                     | Private handler → adapter → writer                                                                                                          | Native purpose / login                                                                                         | Authority source today                                                                                                                                                              | Idempotency, CAS, audit                                                                                               | Error today for a new hotel                                                                             |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Create hotel                  | `POST /api/hotel-setup/properties` (`routes/sharedHotelSetupStatus.ts:1019`, forwards before any auth)                                                                                | `property_creation` / `HOTEL_SETUP_CREATION_COMMAND_*`                                                                        | `hotelSetupCommandService.ts:148` → `hotelSetupCreationCommands.ts` → `writePropertyProfile(create, nativeCreation=true)`                   | `creation`, org login `vayada_next_hotel_setup_org_*` (manual bootstrap, `hotel-setup-creation-bootstrap.yml`) | route: original session, `hotel_catalog.setup.manage`; transaction: `assertHotelSetupCreationScope` (login-bound) + `lockHotelSetupCreationPermissions` (login-independent)         | header key, op `hotel_setup.property.create`; audit `hotel_setup.property.create`                                     | `503 hotel_setup_unavailable` (no org credential)                                                       |
| 2   | Edit hotel details            | `PUT /api/hotel-setup/properties/:id/profile` (`:312` public, `:923` private)                                                                                                         | `property_profile` / `HOTEL_SETUP_PROFILE_COMMAND_*`                                                                          | `:157` → `hotelSetupProfileCommands.ts` → `platform.hotel_setup_property_profile_snapshot` + `platform.hotel_setup_update_property_profile` | `property_profile`, actor-bound login `…_profile_*` (manual bootstrap per property × Owner)                    | route: Owner session, `hotel_owner`, `marketplace.profile.manage`, owner link; SQL: `hotel_setup_profile_authority` (login-bound)                                                   | header key, op `hotel_setup_property_profile_update`, CAS `expectedProfileRevision`, audit `property_profile_updated` | `409 profile_edit_not_provisioned`                                                                      |
| 3   | Launch settings               | `PUT …/launch-settings` (`:831`)                                                                                                                                                      | `launch_settings` / `HOTEL_SETUP_COMMAND_*`                                                                                   | `:152` → `hotelSetupLaunchSettingsCommands.ts` → `writeHotelSetupLaunchSettings`                                                            | `launch_settings`, property login `…_property_*` (automatic provisioning, parked)                              | route: Owner session + owner link; transaction: `withHotelSetupCommandScope` (login-bound) + `lockHotelSetupMembership`                                                             | none; no CAS; audit `property_launch_settings_updated`                                                                | `503 hotel_setup_unavailable`; identity editor shows a misleading error after a successful profile save |
| 4   | Pricing currency              | `PUT /api/pms/properties/:id/pricing-source/currency` (`routes/pmsPricing.ts:66`)                                                                                                     | `currency` / `HOTEL_SETUP_COMMAND_*`                                                                                          | `:143` → `hotelSetupCurrencyCommands.ts` → `pmsPricingCommandRepository` with `hotelSetupCurrencyOperation="currency_ready"`                | `currency_ready`, property login                                                                               | `beginHotelSetupCommandScope` (login-bound) + `lockHotelSetupCurrencyMembership`; first-currency completion by trigger `platform.complete_hotel_setup_first_currency` (login-gated) | header key, CAS `expectedPricingCurrencyRevision`, audit `pms.pricing_currency.upsert`                                | `503 hotel_setup_unavailable`                                                                           |
| 5   | Feature Hub (Financials)      | `GET …/module-activations`, `PATCH …/module-activations/financials` (`routes/pmsModuleActivations.ts:98/161`)                                                                         | `modules`, `financials` / `HOTEL_SETUP_COMMAND_*`                                                                             | `:161` → `hotelSetupFeatureHubCommands.ts` → audit insert; trigger `platform.apply_hotel_setup_feature_hub_command` flips the entitlement   | `feature_hub`, property login                                                                                  | `withHotelSetupCommandScope` (login-bound) + `lockHotelSetupCurrencyMembership(pms.finance.manage)`                                                                                 | none; audit `financials_module_activated                                                                              | deactivated`                                                                                            | `503 hotel_setup_unavailable` |
| 6   | Logo upload, finalize, assign | `POST /api/media/upload-sessions`, `POST …/:sessionId/finalize` (`routes/platformMedia.ts:946/1262`), `PUT /api/hotel-setup/properties/:id/media/logo` (`routes/propertyMedia.ts:58`) | `logo_upload`, `logo_finalize`, `logo_assignment` / `HOTEL_SETUP_LOGO_COMMAND_*` (**defaults to `blocked`**, `server.ts:354`) | `:107–141` → `hotelSetupLogoRuntime.ts` request-bound media repositories                                                                    | `property_logo`, actor-bound login `…_logo_*` (manual bootstrap)                                               | `assertHotelSetupLogoScope` (login-bound) + per-table RLS keyed on `platform.hotel_setup_logo_context()`                                                                            | assign: header key, op `hotel_catalog.property_media.logo.assign`, CAS `expectedProfileRevision`; media receipts      | `503 hotel_setup_unavailable`                                                                           |

Forwarding happens **before** route authorization for creation, currency, the
module list and the Financials toggle (`sharedHotelSetupStatus.ts:1020`,
`pmsPricing.ts:56/70`, `pmsModuleActivations.ts:109/184`), and **after** it for
profile, launch settings and the three logo routes (`sharedHotelSetupStatus.ts:324/869`,
`platformMedia.ts:875→957` and `:1227→1266`, `propertyMedia.ts:37→59`). The
ordinary routes therefore add the private handlers' gates explicitly (§5.1).

Web callers (all already send the `Idempotency-Key` the forwarder demands):
`packages/product-onboarding/src/sharedHotelSetupApi.ts` (create 111, profile
119, logo 162–228), `apps/marketplace-web/services/api/hotels.ts:555`,
`apps/marketplace-web/services/api/hotelOperationsSetupClient.ts:279` (launch
settings, no key needed), `apps/marketplace-web/services/api/pricingSetupClient.ts:192`,
`apps/pms-web/services/api/pmsPropertyClient.ts:183`,
`apps/pms-web/services/api/moduleActivationClient.ts`,
`apps/booking-admin/services/api/moduleActivationClient.ts`. The identity editor
double PUT (profile, then launch settings) is `SharedFirstRunPropertySetupWizard.tsx:599–668`.

## 2. What the ordinary login already has (verified against the grant script)

Platform `scripts/grant-target-database-runtime-product-dml.mjs` (product DML
posture, live since 2026-10-07):

- `SELECT, INSERT, UPDATE, DELETE` on every non-protected relation in
  `hotel_catalog`, `booking`, `pms`, `marketplace`, `distribution`, `finance`,
  `platform` (narrowings: `platform.product_audit_events` and
  `platform.domain_events` insert-only, no `DELETE` on `hotel_catalog.properties`).
- `identity.organization_resource_links`: `INSERT (organization_id, product,
resource_type, resource_id, relationship, status)`, `UPDATE (id, status, updated_at)`.
- `identity.product_entitlements`: `INSERT (organization_id, product,
entitlement_key, status, starts_at, expires_at, metadata, resource_product,
resource_type, resource_id)`, `UPDATE (status, starts_at, expires_at, updated_at, metadata)`.
- `UPDATE (created_at)` lock column on `identity.organizations`, `users`,
  `organization_memberships`, `role_permission_grants`,
  `membership_property_assignments`, `organization_roles` (`FOR SHARE` /
  `FOR KEY SHARE` locks work).
- No `EXECUTE` on any `SECURITY DEFINER` routine (`runtime_security_definer_execute_forbidden`,
  asserted by the tf-apply preflight in both postures and inside the grant transaction).

Every write statement of the six operations maps onto that set (§5). Row-level
security on the touched tables never blocks the ordinary login: the hotel-setup
guards (`0436`, `0437`, `0439`, `0441`, `0453`, `0458`, `0462`, `0468`, `0470`)
are `RESTRICTIVE TO PUBLIC` with the predicate
`session_user !~ '^vayada_next_hotel_setup_…' AND NOT pg_has_role(…scope, 'MEMBER')`,
i.e. they pass for any non-native login; the worker and pricing policies
(`0327`, `0407`, `0413`, `0414`, `0421`, `0422`, `0429`) likewise exempt it (VAY-2054
verified 222 of 224 policies key on the login).

## 3. Per-function authority analysis

The crux of the ticket. "Login-bound" means the function reads `session_user`,
`current_user`, `pg_has_role` or a `platform.hotel_setup_*_scopes` /
`hotel_setup_linked_properties` row keyed on the native login, so calling it as
`vayada_next_api_runtime` returns `false`, raises, or returns early. Quoted
predicates are verbatim from the migrations.

| Migration      | Function (schema `platform`)                                                                                                                                                                                                                      | SECURITY DEFINER     | Authority source (quoted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verdict for `vayada_next_api_runtime`                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0436           | `record_hotel_setup_owner_link()` trigger on `identity.organization_resource_links`                                                                                                                                                               | yes                  | trigger row only; writes `hotel_setup_linked_properties` as owner                                                                                                                                                                                                                                                                                                                                                                                                                                        | login-independent (works for the ordinary creation insert)                                                                                                                              |
| 0436/0437      | `hotel_setup_property_read_allowed(uuid,uuid)`                                                                                                                                                                                                    | yes                  | `FROM platform.hotel_setup_creation_scopes scope … WHERE scope.database_login = session_user`                                                                                                                                                                                                                                                                                                                                                                                                            | login-bound                                                                                                                                                                             |
| 0436/0437      | `hotel_setup_property_id_unlinked(uuid)`, `hotel_setup_property_link_matches(uuid,text)`                                                                                                                                                          | yes / no             | parameters only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | login-independent (RLS helpers, not needed)                                                                                                                                             |
| 0437           | `hotel_setup_owner_link_insert_allowed(uuid,text)`                                                                                                                                                                                                | yes                  | `scope.database_login = session_user AND scope.organization_id = $1`                                                                                                                                                                                                                                                                                                                                                                                                                                     | login-bound                                                                                                                                                                             |
| 0439           | `hotel_setup_pending_financials_allowed(uuid,text)`                                                                                                                                                                                               | yes                  | same scope join on `session_user`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | login-bound                                                                                                                                                                             |
| 0453/0454      | `hotel_setup_new_property_allowed(uuid)`                                                                                                                                                                                                          | yes                  | `assigned_organization := platform.hotel_setup_creation_assigned_organization()` + `property.xmin = pg_current_xact_id()::xid`                                                                                                                                                                                                                                                                                                                                                                           | login-bound, transaction-bound                                                                                                                                                          |
| 0454           | `hotel_setup_creation_assigned_organization()`                                                                                                                                                                                                    | yes                  | `WHERE scope.database_login = session_user … FOR UPDATE OF organization FOR SHARE OF scope`                                                                                                                                                                                                                                                                                                                                                                                                              | login-bound (it is the login→organization resolver)                                                                                                                                     |
| 0457           | `hotel_setup_creation_product_link_allowed(uuid,text,text,text)`                                                                                                                                                                                  | yes                  | via the resolver and `hotel_setup_new_property_allowed`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | login-bound                                                                                                                                                                             |
| 0458           | `guard_hotel_setup_creation_key_completion()` trigger on `platform.idempotency_keys`                                                                                                                                                              | yes                  | `IF session_user::text !~ '^vayada_next_hotel_setup_org_' AND (NOT pg_has_role(…) OR rolsuper) THEN RETURN NEW`                                                                                                                                                                                                                                                                                                                                                                                          | login-bound gate; pass-through for the ordinary login                                                                                                                                   |
| 0459           | `hotel_setup_creation_audit_key_allowed(uuid,uuid,text)`                                                                                                                                                                                          | yes                  | via the resolver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | login-bound                                                                                                                                                                             |
| 0450/0460      | `hotel_setup_reader_audit_allowed(product_audit_events)`                                                                                                                                                                                          | no (invoker)         | `IF session_user NOT IN ('vayada_next_hotel_setup_reader', '…_creation_reader') … THEN RETURN true`                                                                                                                                                                                                                                                                                                                                                                                                      | login-bound by name; `true` for the ordinary login                                                                                                                                      |
| 0441/0444      | `hotel_setup_property_allowed(uuid,uuid)`                                                                                                                                                                                                         | yes                  | `WHERE scope.database_login = session_user AND scope.active AND scope.property_id = … FOR UPDATE OF organization FOR SHARE OF scope`                                                                                                                                                                                                                                                                                                                                                                     | login-bound                                                                                                                                                                             |
| 0441           | `hotel_setup_property_row_allowed`, `_owner_link_allowed`, `_financials_read_allowed`                                                                                                                                                             | no                   | `IF current_user <> session_user OR NOT pg_has_role(session_user,'vayada_next_hotel_setup_property_scope','USAGE') THEN RETURN FALSE`                                                                                                                                                                                                                                                                                                                                                                    | login-bound                                                                                                                                                                             |
| 0442/0462      | `hotel_setup_property_operation_allowed(uuid,text)`                                                                                                                                                                                               | yes                  | `scope.database_login=session_user AND scope.operation_class=requested_operation_class AND scope.active`                                                                                                                                                                                                                                                                                                                                                                                                 | login-bound; the purpose itself is a property of the login                                                                                                                              |
| 0443           | `hotel_setup_property_assigned_organization()`                                                                                                                                                                                                    | yes                  | `IF NOT pg_has_role(session_user, …,'USAGE') THEN RETURN NULL; … WHERE scope.database_login = session_user AND scope.active`                                                                                                                                                                                                                                                                                                                                                                             | login-bound                                                                                                                                                                             |
| 0447           | `lock_entitlement_routing_organization()` trigger on `identity.product_entitlements`                                                                                                                                                              | yes                  | `FOR KEY SHARE` on the organization only                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | login-independent                                                                                                                                                                       |
| 0448/0452/0461 | `guard_hotel_setup_completion_evidence()` trigger (4 evidence tables + pricing settings, ENABLE ALWAYS)                                                                                                                                           | no                   | `IF session_user::text !~ '^vayada_next_hotel_setup_property_' AND (NOT pg_has_role(…) OR rolsuper) THEN RETURN NEW`                                                                                                                                                                                                                                                                                                                                                                                     | login-bound gate; pass-through                                                                                                                                                          |
| 0448           | `complete_hotel_setup_first_currency()` deferred constraint trigger                                                                                                                                                                               | yes                  | `IF NOT platform.hotel_setup_property_operation_allowed(NEW.property_id,'currency_ready') THEN RETURN NEW`                                                                                                                                                                                                                                                                                                                                                                                               | login-bound; **does nothing for the ordinary login**, so A6 ports the completion (categories, `newHotelFinancialsDefault='ready'`, activation)                                          |
| 0449           | `guard_hotel_setup_owner_off_receipt()` trigger on `identity.product_entitlements`                                                                                                                                                                | yes                  | `session_user::text ~ '^vayada_next_hotel_setup_property_' …` else strips `newHotelFinancialsOwnerDisabled`                                                                                                                                                                                                                                                                                                                                                                                              | login-bound; the ordinary login can never write that key (nothing in the ordinary API reads it)                                                                                         |
| 0449           | `apply_hotel_setup_feature_hub_command()` BEFORE/AFTER INSERT on `platform.product_audit_events`                                                                                                                                                  | yes                  | `IF NOT pg_has_role(session_user, …,'MEMBER') AND session_user::text !~ '^vayada_next_hotel_setup_property_' THEN RETURN NEW`                                                                                                                                                                                                                                                                                                                                                                            | login-bound gate; pass-through (the ordinary writer flips the entitlement itself)                                                                                                       |
| 0465           | `tenant_scope_key`, `valid_tenant_scope` (0010 helpers, grants only)                                                                                                                                                                              | no                   | pure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | login-independent, already executable by PUBLIC                                                                                                                                         |
| 0466/0468      | `hotel_setup_logo_allowed`, `_row_allowed`, `_bootstrap_proof_allowed`, `hotel_setup_logo_authority(uuid,uuid,uuid,boolean)`                                                                                                                      | yes / no / yes / yes | `session_user::text !~ '^vayada_next_hotel_setup_logo_[a-z0-9_]+$'`, `pg_roles WHERE rolname=session_user`, `scope.database_login=session_user AND scope.operation_class='property_logo' AND scope.actor_user_id=…`                                                                                                                                                                                                                                                                                      | login-bound                                                                                                                                                                             |
| 0468           | `hotel_setup_logo_login_guard()` (PUBLIC restrictive guard on 13 tables)                                                                                                                                                                          | no                   | regex + `pg_has_role` with superuser/`vayada_admin` carve-outs                                                                                                                                                                                                                                                                                                                                                                                                                                           | login-bound; `true` for the ordinary login                                                                                                                                              |
| 0468           | `hotel_setup_logo_context()` and every predicate built on it (`_property`, `_organization`, `_media_read`, `_media_upload_binding`, `_job_read`, `_session_valid`, `_job_valid`, `_public_key`), `sync_hotel_setup_logo_read_models(uuid)` (0469) | yes                  | `FROM platform.hotel_setup_property_scopes WHERE database_login=session_user AND active AND operation_class='property_logo'`                                                                                                                                                                                                                                                                                                                                                                             | login-bound; `NULL` context for the ordinary login, so every logo-scope policy is false for it (irrelevant: the logo-scope policies apply only `TO vayada_next_hotel_setup_logo_scope`) |
| 0468           | `hotel_setup_logo_profile_revision_guard()` BEFORE UPDATE on `hotel_catalog.properties`                                                                                                                                                           | yes                  | `IF session_user::text !~ '^vayada_next_hotel_setup_logo_' … THEN RETURN NEW`                                                                                                                                                                                                                                                                                                                                                                                                                            | login-bound gate; pass-through                                                                                                                                                          |
| 0467/0468      | `hotel_setup_logo_session_binding`, `_safe_variant`, `_manifest_valid`, `hotel_setup_media_session_allocation_guard()` trigger                                                                                                                    | no / no / no / yes   | pure validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | login-independent (the allocation guard already applies to every media writer)                                                                                                          |
| 0470           | `hotel_setup_profile_authority(uuid,uuid,uuid,boolean)`                                                                                                                                                                                           | yes                  | lines 40–80: `session_user::text !~ '^vayada_next_hotel_setup_profile_[a-z0-9_]+$'`, `pg_roles WHERE rolname=session_user AND rolcanlogin …`, `scope.database_login=session_user AND scope.active AND scope.operation_class='property_profile' AND scope.actor_user_id=requested_actor_user_id … credential_role_oid=login_oid`; lines 82–111 identity-only (actor is `hotel_owner`, account-admin preset, no overrides, `hotel_catalog.setup.manage` + `marketplace.profile.manage`, active owner link) | login-bound; the identity half is what A3 reproduces in application SQL                                                                                                                 |
| 0470           | `hotel_setup_profile_allowed`, `_bootstrap_proof_allowed`, `hotel_setup_property_profile_snapshot(uuid,uuid,uuid)`                                                                                                                                | yes                  | each is a wrapper over the authority gate (`RAISE … 'HSP03'`)                                                                                                                                                                                                                                                                                                                                                                                                                                            | login-bound                                                                                                                                                                             |
| 0470/0471      | `hotel_setup_property_profile_row(uuid)`, `hotel_setup_sync_property_read_models(uuid)`                                                                                                                                                           | yes                  | parameters only (no grant to any login)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | login-independent, but unreachable without a definer grant; the ordinary path uses the existing ordinary projections instead                                                            |
| 0472           | `hotel_setup_update_property_profile(uuid,uuid,uuid,bigint,jsonb,text,text,text)`                                                                                                                                                                 | yes                  | only `IF NOT platform.hotel_setup_profile_authority(…,FALSE) THEN RAISE … 'HSP03'`; the body (validation `22023`, idempotency replay/conflict, revision CAS, private-contact conflict, writes, read-model sync, key + audit insert) is parameterised                                                                                                                                                                                                                                                     | login-bound through one gate; its body is the specification for A3                                                                                                                      |

Login-independent in the whole range: `record_hotel_setup_owner_link`,
`hotel_setup_property_id_unlinked`, `hotel_setup_property_link_matches`,
`lock_entitlement_routing_organization`, `hotel_setup_logo_session_binding`,
`hotel_setup_media_session_allocation_guard`, `hotel_setup_logo_safe_variant`,
`hotel_setup_logo_manifest_valid`, `hotel_setup_property_profile_row`,
`hotel_setup_sync_property_read_models`, and the 0010 tenant helpers. None of
them is a writer the ordinary path needs to call.

Consequences:

- **No hotel-setup `SECURITY DEFINER` writer or helper is login-independent.**
  The profile writer's gate `platform.hotel_setup_profile_authority` checks
  `session_user::text !~ '^vayada_next_hotel_setup_profile_[a-z0-9_]+$'` and
  `scope.database_login=session_user AND scope.operation_class='property_profile'`
  (`0470:41,72`); `hotel_setup_property_operation_allowed` and
  `hotel_setup_creation_assigned_organization` read the scope tables by
  `session_user`; the logo functions go through `hotel_setup_logo_context()`.
  Granting the runtime role EXECUTE on them would be a dead grant that still
  trips the preflight.
- **The login-independent authority logic already exists in TypeScript**:
  `apps/api/src/hotelSetupMembership.ts` (`lockHotelSetupMembership`,
  `lockHotelSetupCreationPermissions`) and `hotelSetupCurrencyMembership.ts` lock
  the actor's membership, role definition, grants, assignments and user row
  `FOR SHARE` and resolve effective permissions. They take the actor as a
  parameter and never read `session_user`. The native launch-settings, currency
  and Feature Hub commands already call them after their login-bound scope
  assertion. The ordinary design keeps these calls and drops only the scope
  assertion.
- **Triggers that fire for every login are safe**:
  `platform.record_hotel_setup_owner_link` (`0436`, AFTER INSERT on
  `identity.organization_resource_links`) is `SECURITY DEFINER` and writes the
  protected `platform.hotel_setup_linked_properties` as the owner, so the
  ordinary creation insert works; `guard_hotel_setup_completion_evidence`
  (`0448`), `guard_hotel_setup_owner_off_receipt` and
  `apply_hotel_setup_feature_hub_command` (`0449`),
  `guard_hotel_setup_creation_key_completion` (`0458`) and
  `hotel_setup_logo_profile_revision_guard` (`0468`) `RETURN NEW` immediately
  for non-native logins; `lock_entitlement_routing_organization` (`0447`) only
  takes a `FOR KEY SHARE` lock; `hotel_setup_media_session_allocation_guard`
  (`0468`) is login-neutral validation that already applies to every media
  writer.

## 4. Pinned-object impact

The seven native preflights (`apps/api/src/hotelSetup{Creation,Currency,
LaunchSettings,Logo,Profile,FeatureHub,Reader}Privileges.ts`) pin md5 digests of
policies, triggers, function bodies, view definitions and check constraints on
the tables below and run at private-service startup and inside every native
transaction. Any `CREATE POLICY`, `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION`
or view change on a pinned object stops the running creation and property
services until they are re-released.

Where each assertion runs (verified in code): creation, launch settings, logo
and profile re-attest **inside every native transaction**; the reader
attests at private-service **startup**; currency and Feature Hub attest only in
the CLI preflight and in automatic provisioning. **The public API process never
runs any `assertHotelSetup*Privileges`**, so nothing in this plan can trip a
digest from inside the ordinary path. Every check is `current_user`-relative
(`has_column_privilege(current_user, …)`, `has_function_privilege(current_user, …)`):
grants to a different named role are invisible, grants `TO PUBLIC` are not.
`pg_get_functiondef` never renders ACLs, so no digest covers `proacl` or `relacl`.

| Pinned object class                                                    | Creation (`org_*`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Feature Hub                                                                                                                                                                                                | Currency / currency_ready                                                                                                                                                                                                                                                | Launch settings                                                                                                                                                                                                                                        | Logo                                                                                                                                                                                                                                                                                             | Profile                              | Reader                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------- |
| Policy digest (all policies on the listed tables, any role)            | `2962458a…` over 20 relations: `identity.{users, organization_memberships, organization_roles, role_permission_grants, organizations, organization_resource_links, product_entitlements}`, `finance.billing_entitlements`, `hotel_catalog.{hotel_setup_effective_creation_scopes, organization_setup_track_intents, properties, property_locations, property_contact_channels, property_owner_revisions}`, `booking.{pricing_runtime_effective_property_scopes, pricing_runtime_effective_authority_scopes, booking_settings}`, `marketplace.marketplace_hotel_profiles`, `platform.{idempotency_keys, product_audit_events}` | `e55f55fa…` over 9: identity users/memberships/assignments/roles/grants/product_entitlements, `platform.{idempotency_keys, domain_events, product_audit_events}`                                           | `3c207305…` / `6a9dc494…` over 15 (+`finance.expense_categories`): the identity six, `pms.{property_pricing_settings, room_types, rate_plans, rate_rules, recurring_pricing_sources}`, `platform.{idempotency_keys, domain_events, outbox_events, product_audit_events}` | `6167ec97…` over 14: identity five, `hotel_catalog.{properties, property_contact_channels, property_public_profile_read_model}`, `booking.booking_settings`, the two pricing views, `platform.{idempotency_keys, domain_events, product_audit_events}` | `7b295d5a…` over 13: `identity.{organizations, organization_resource_links}`, `hotel_catalog.{properties, property_profiles, property_media}`, `platform.{media_upload_sessions, media_objects, media_variants, idempotency_keys, jobs, job_attempts, dead_letter_events, product_audit_events}` | none (login has no table privilege)  | `platform.product_audit_events` only (`bf4f04e9…`)                                     |
| Trigger digest (`pg_get_triggerdef` + trigger function body + enabled) | `e2b189f2…` same 20                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | none                                                                                                                                                                                                       | `b8990e86…` / `eaed32a2…` same lists                                                                                                                                                                                                                                     | `7ef659a4…` same 14                                                                                                                                                                                                                                    | `92be49d0…` same 13                                                                                                                                                                                                                                                                              | none                                 | audit table (`c039e04d…`)                                                              |
| Function-body digest                                                   | `0531e55e…`: 8 creation definers + `hotel_setup_property_link_matches`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `b59c9714…`: the 7 property functions (`hotel_setup_property_allowed`, `_operation_allowed`, `_assigned_organization`, `_row_allowed`, `_owner_link_allowed`, `_financials_read_allowed`, `_link_matches`) | same `b59c9714…`                                                                                                                                                                                                                                                         | same `b59c9714…`                                                                                                                                                                                                                                       | `982ab3ea…`: 25 logo helpers + `hotel_setup_logo_authority`, incl. `tenant_scope_key`, `valid_tenant_scope`, `valid_media_purpose_visibility`, the Channex and Finance worker scope helpers                                                                                                      | `c0f1afcf…`: the 7 profile functions | `hotel_setup_reader_audit_allowed` (`990c9f2f…`, all purposes except profile and logo) |
| View / constraint digests                                              | `68e32b85…` (3 views), `0f073477…` (`platform.pricing_runtime_property_scopes` CHECKs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                        | `8c37b2a7…` (2 pricing views), `0f073477…`                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                | —                                    | readiness columns + CHECK on both scope tables                                         |
| Exact column matrix + "no other definer executable"                    | yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | yes                                                                                                                                                                                                        | yes                                                                                                                                                                                                                                                                      | yes                                                                                                                                                                                                                                                    | yes                                                                                                                                                                                                                                                                                              | no table privilege at all            | yes, no definer at all                                                                 |

Shared trigger functions whose body is pinned by several purposes:
`platform.prevent_append_only_mutation` (domain_events, product_audit_events),
`platform.record_hotel_setup_owner_link`, `platform.lock_entitlement_routing_organization`,
`platform.guard_hotel_setup_owner_off_receipt`, `platform.hotel_setup_logo_profile_revision_guard`,
`platform.guard_hotel_setup_creation_key_completion`, `platform.hotel_setup_media_session_allocation_guard`,
`platform.apply_hotel_setup_feature_hub_command`, `platform.guard_hotel_setup_completion_evidence`,
`platform.complete_hotel_setup_first_currency`, plus the identity and PMS trigger
functions already on those tables.

Additive-safe while the native services run: `GRANT` of any privilege on any
table or function to a named role, new tables/views/columns not referenced by a
pinned view, new `SECURITY INVOKER` functions, new `SECURITY DEFINER` functions
with `REVOKE EXECUTE FROM PUBLIC` in the same transaction. Breaking: any
`CREATE/ALTER/DROP POLICY` on a listed table (even `TO vayada_next_api_runtime`
only), enabling or forcing RLS, any trigger change or trigger-function
replacement on a listed table, `CREATE OR REPLACE` of a pinned function, view
or CHECK changes, ownership changes, any `GRANT … TO PUBLIC`.

**This plan ships zero migrations in the first release**, so the impact table
is empty: no policy, trigger, function, view or constraint changes; no grant
changes (a `GRANT` to a different role is not covered by any digest, and none is
needed anyway). The running native services keep passing their preflights
throughout, which is what makes image-only rollback possible (§9). VAY-2055 (migration 0473, merged and applied
2026-10-07) re-pinned six digests and re-released the native images; §9 states
the rule for any later migration.

Rules for the later decommission migrations (§12): they may only run after the
native services are stopped and the native preflights are retired from the
codebase; every `DROP POLICY` / `DROP TRIGGER` / `DROP FUNCTION` there is by
definition a pinned-object change.

## 5. Target design per operation (as built, PRs #2930–#2935)

Common shape for every write on the ordinary login. The scope wrapper is
implemented once, `withOrdinaryHotelSetupPropertyScope` in
`apps/api/src/hotelSetupOrdinaryScope.ts`:

1. Route authorization runs the private handler's gates on the public route
   (§5.1). `owner_session_required` (403) keeps its meaning.
2. One READ COMMITTED transaction. The organization row is locked `FOR UPDATE`
   (only `FOR UPDATE` makes a concurrent suspension wait, 0444/0447), the
   active catalog **and** PMS owner links `FOR SHARE` and verified, because
   `lockHotelSetupMembership` assumes the owner link (`hotelSetupMembership.ts:67-78`).
   Then the actor's membership, role definition, grants, assignments and user
   row are re-locked and permissions re-derived (`lockHotelSetupMembership` or
   `lockHotelSetupCurrencyMembership`, which also re-reads the entitlements
   after the locks). Then the write, idempotency and audit statements, `COMMIT`.
   A lost scope denies with `AuthorizationError` (403) or the operation's own
   scope failure.
3. No `assertHotelSetup*Privileges`, no `withHotelSetupCommandScope`, no
   credential resolver, no `HotelSetupAssignmentMissingError`, no
   `not_provisioned` result.

| Op                | PR           | Ordinary writer                                                                                            | Authority in the transaction                                                                                                                                                                                                                                                                                          | Writes (all granted)                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Create          | #2934        | `writePropertyProfile(create)` on a **separate** repository instance with `hotelSetupOwnerCreation`        | organization `FOR UPDATE` + `lockHotelSetupCreationPermissions` (setup permission, published-surface permission), provisioning-only inputs refused, owner link only for a property created in this transaction (`xmin`). Platform-admin provisioning keeps the shared instance without the Owner re-check (review H3) | properties, locations, contacts, owner revisions, product links and pending Financials default (identity matrix), Marketplace profile, Booking settings, idempotency key, audit                                                                                                                                                                                                         |
| 2 Profile         | #2930, #2931 | `writeOrdinaryHotelSetupPropertyProfile` (`platform/hotelSetupProfileWriter.ts`), port of 0472             | the parameterised half of `hotel_setup_profile_authority` (0470:82-111): `hotel_owner`, no overrides, account-admin preset, both permission grants, active actor, property access, active catalog owner link to a non-retired property, behind organization `FOR UPDATE`                                              | properties, locations, contacts, read models (`syncPropertyOfferReadModels`), idempotency key (same operation, tenant scope, key hash and fingerprint as native, so retries replay across the cutover), audit with changed field names                                                                                                                                                  |
| 3 Launch settings | #2932        | the native body of `writeHotelSetupLaunchSettings` with the ordinary scope runner                          | wrapper + `lockHotelSetupMembership` + setup permission + effective access                                                                                                                                                                                                                                            | Booking settings (4 columns), social contacts, public-contact projection, audit. No `profile_revision` bump (decision 4). A missing Booking settings row answers 404                                                                                                                                                                                                                    |
| 4 Currency        | #2933        | `createPgPmsPricingCommandRepository({ hotelSetupOrdinaryOwner: true })` for the currency route only       | wrapper first, then `lockHotelSetupCurrencyMembership` (overrides, role definitions, assignments, PMS access flag, `property-management`/`pms-core`/`account_access` aliases and suspensions)                                                                                                                         | pricing settings, starter categories, then `completeOrdinaryHotelSetupFirstCurrency`, a port of the 0448 trigger: same currency list and prerequisites, entitlement `active` with `newHotelFinancialsDefault='ready'` and the activation transaction, a `pms.financials.default_activated` audit linked to the currency audit. A failed prerequisite aborts the whole save (decision 3) |
| 5 Feature Hub     | #2935        | `createOrdinaryHotelSetupFeatureHubCommands` (`hotelSetupFeatureHubOrdinary.ts`), port of the 0449 command | wrapper + `lockHotelSetupCurrencyMembership(pms.finance.manage, base access when enabling)`, `module:financials` row `FOR UPDATE`, the 0449 activation predicate (completed default, live window, supported currency, no other suspended PMS entitlement, active base)                                                | entitlement status and Owner-off marker, audit with the native action names and metadata keys (`actorOrganizationId`, `hotelSetupTransaction`)                                                                                                                                                                                                                                          |
| 6 Logo            | A9           | the standard property-media protocol with the logo-only Owner gates (§5.2)                                 | as today on the private service                                                                                                                                                                                                                                                                                       | media sessions, objects, variants, jobs, property media, profile revision, idempotency key, receipts                                                                                                                                                                                                                                                                                    |

**Owner-off versus a foreign suspension (review H1).** The 0449 receipt
trigger strips `newHotelFinancialsOwnerDisabled` from every non-native write
(`0449:2-14`), so the ordinary login records an Owner's switch-off as
`featureHubOwnerDisabled: true`. Re-enabling requires `active`, or `suspended`
with either Owner-off key: rows switched off natively before the cutover can
still be switched back on, and a suspension by anyone else never can.

### 5.1 Public route options (review H2)

| Route                                     | Registration on the public API                                                                                                                                                         | Denial test (public app)                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /api/hotel-setup/properties`        | `propertyCreationRepository` (Owner mode) + `requireOwnerSession`                                                                                                                      | `sharedHotelSetupStatus.test.ts` "self-serve hotel through the Owner-mode repository"     |
| `PUT …/profile`                           | `hotelSetupPropertyProfileUpdateHandler`, the private handler: original session, `hotel_owner`, `marketplace.profile.manage`, owner link, effective access, `Idempotency-Key`          | "Owner-only ordinary command without the sparse writer"                                   |
| `PUT …/launch-settings`                   | `launchSettingsCommand` + `requireOwnerSession` + `propertyAccessRepository`                                                                                                           | "Owner-only ordinary command, never the broad writer"                                     |
| `PUT /api/pms/…/pricing-source/currency`  | `currencyCommandPort` + `requireOwnerSession` + `propertyAccessRepository`                                                                                                             | `pmsPricingRoutes.test.ts` "ordinary hotel-setup port behind Owner-only gates"            |
| `GET/PATCH /api/pms/…/module-activations` | `requireOwnerSession` + `financialsSetupComplete` (repository) + `propertyAccessRepository`; without `financialsSetupComplete` every new hotel would need an operator allow-list entry | `pmsModuleActivations.test.ts` "switch Financials off and on with no operator allow-list" |
| logo upload, finalize, assign             | §5.2                                                                                                                                                                                   | A9                                                                                        |

### 5.2 Logo authorization (review M3, decision)

The ordinary logo path keeps today's Owner-only rules from the private service
(`hotelSetupCommandService.ts:117-134`): original session, hotel group,
`hotel_owner`, `hotel_catalog.setup.manage`, active owner link and effective
access for `property.logo`. It does **not** relax to the shared media policy
(owner or operator). Other media purposes are unchanged.

The public API stops calling `loadHotelSetupCommandForwarder` for the six
operations. The installed `HOTEL_SETUP_*_COMMAND_*` task-definition variables
become inert and stay installed until the decommission PR relaxes
`assert-hotel-setup-caller-retained.py` (platform tf-apply gate). The forwarder
module, the private service entry point and the native adapters stay in the
tree for the rollback image and the decommission PRs.

## 6. What stays `SECURITY DEFINER`, and why

Everything that exists today stays exactly as deployed, because the native
services still run during the observation window and pin it:

- creation helpers (`0436`, `0437`, `0439`, `0453`–`0461`), property helpers
  (`0441`, `0442`, `0462`), currency completion (`0448`, `0452`), Feature Hub
  trigger (`0449`), reader audit (`0450`, `0460`), tenant helpers (`0465`), logo
  (`0466`–`0469`), profile (`0470`–`0472`), identity lock policies (`0443`,
  `0446`, `0447`).
- None of them is granted to `vayada_next_api_runtime`. They are owner- and
  purpose-role-only, as VAY-2054 recorded.
- They are dropped by the decommission migrations (§12), after the native
  services are stopped and the native preflights removed from the app.

New code adds **no** `SECURITY DEFINER` function: with ordinary DML the
definer boundary would protect nothing the role cannot already write, and the
in-transaction authority re-check lives in application SQL as it already does
for the launch-settings, currency and Feature Hub native commands.

## 7. The explicit definer exception list

Platform PR #454 (merged 2026-10-07, main `be9377e`; its grant was re-applied in
production the same evening, preflight PASS in the product DML posture) adds
`runtimeExecutableFunctions` (invoker-rights helpers) to the grant script and
the preflight with parity tests. The brief asks for a sibling
`runtimeDefinerFunctions` list for this ticket. Given §3, the correct content
of that list is empty, and the current preflight already states the exact
set of definer functions the role may execute (none) and fails closed on any
other (`runtime_security_definer_execute_forbidden`, both postures, plus the
grant transaction's `verifyGlobalPosture`). Two ways to record this:

- **Option A (decided, §13.1): no new mechanism.** Platform PR limited to docs:
  `docs/environments.md` gets a VAY-2056 paragraph stating that the hotel-setup
  purposes run on the ordinary login with zero definer exceptions, that the
  existing check is the exact list, and how the private services are retired.
  Acceptance "preflight lists the exact definer functions" is met by the
  existing fail-closed check; no grant re-run is needed.
- **Option B: add the empty explicit list anyway** (on current platform main, same
  three files plus parity test): `runtimeDefinerFunctions = []` in both scripts,
  carve-out `AND procedure.oid <> ALL($n)` in both definer queries, codes
  `runtime_definer_function_missing` / `_not_definer` / `_owner_required` /
  `_public_execute_forbidden`, integration fixture with one allowlisted definer
  proving the carve-out and `app.owner_only()` still failing. About 150–200
  lines; useful only if a future ticket really needs a definer exception.

Option A was chosen at the PLAN checkpoint.

## 8. PR slices (as built)

All app PRs stack on `fm/vay-2056-self-serve-signup` with merge commits, never
force-pushed. Each brings its PG16/PG17 suite into the `hotel-setup` shard of
`.github/workflows/pr-checks.yml`, which also runs on `fm/vay-2056-*` bases.

| #   | PR    | Branch                                            | Content                                                                                                                                                                                                                                                     |
| --- | ----- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | #2928 | `fm/vay-2056-self-serve-signup`                   | this note; CI on the stacked branches                                                                                                                                                                                                                       |
| A2  | #2929 | `fm/vay-2056-ordinary-role-fixture`               | test login mirroring the VAY-2054 grant set; asserts the preflight's own posture queries (no definer execute, identity writes only in the matrix and lock column, protected reads denied). Must be updated when VAY-2057 slice 0.3 edits the protected list |
| A3  | #2930 | `fm/vay-2056-profile-ordinary-writer`             | ordinary profile writer + native-parity suite. Denials are proven at the application layer: the login itself has table `UPDATE`                                                                                                                             |
| A4  | #2931 | `fm/vay-2056-profile-route`                       | public profile route on the Owner-only handler                                                                                                                                                                                                              |
| A5  | #2932 | `fm/vay-2056-launch-settings-ordinary`            | shared scope wrapper, launch settings, 404 on a missing Booking row                                                                                                                                                                                         |
| A6  | #2933 | `fm/vay-2056-currency-ordinary`                   | currency route, strict Owner re-check, first-currency completion                                                                                                                                                                                            |
| A7  | #2934 | `fm/vay-2056-creation-ordinary`                   | Owner-mode creation, provisioning regression, same-transaction owner link                                                                                                                                                                                   |
| A8  | #2935 | `fm/vay-2056-feature-hub-ordinary`                | Feature Hub port, Owner-only module routes with `financialsSetupComplete`                                                                                                                                                                                   |
| A9  | —     | `fm/vay-2056-logo-ordinary`                       | logo on the ordinary login with the Owner-only gates (§5.2)                                                                                                                                                                                                 |
| A10 | —     | `fm/vay-2056-docs`                                | superseded headers on the VAY-965 contracts, `api-runtime-database-role.md`                                                                                                                                                                                 |
| P1  | —     | platform `fm/vay-2056-runtime-definer-exceptions` | `docs/environments.md` VAY-2056 paragraph (Option A)                                                                                                                                                                                                        |

## 9. Release and rollback sequence

No migration, no grant, no protected workflow, no Terraform change in the
first release.

1. **The stack lands on `main` as one release** (review L7): merge the stack in
   one go immediately before the cutover deploy. Merging slices one by one
   would ship each with the next unrelated `deploy-next-api`.
2. Platform P1 merged (docs only).
3. **Cutover = one ordinary next-API release** (`deploy-next-api.yml`). The
   new image ignores `HOTEL_SETUP_CREATION_COMMAND_*`, `HOTEL_SETUP_COMMAND_*`
   (currency, launch settings, modules), `HOTEL_SETUP_PROFILE_COMMAND_*` and
   `HOTEL_SETUP_LOGO_COMMAND_*`; the task definition keeps them. The private
   services `vayada-hotel-setup-service` and `vayada-hotel-setup-property-service`
   keep running idle on the images re-released with VAY-2055 (migration 0473).
4. Production acceptance (coordinator, read-only evidence + throwaway Owner on
   the `next-*` hosts): sign up → create hotel → logo → edit details → launch
   settings → currency → Feature Hub, zero operator steps; both original Owners
   edit → save → reload → revert; `/ecs/vayada-next-api` shows no `42501`.
5. Observation window 1–2 weeks with the native services still running but
   uncalled, then the decommission PRs (§12).

**Operations note (review L3).** After the cutover the admission variables are
no longer a kill switch: `hotel-setup-release.yml state=blocked` changes nothing
on the new image. Stopping the six operations means rolling the API image back.

**Rollback window (review H4).** Rollback is redeploying the previous next-API
image: it reads the still-installed admission variables and forwards to the
still-running private services. This holds only while every object the native
preflights pin (§4) is unchanged. VAY-2055 (#2917, migration 0473) re-pinned six
digests and the native images were re-released with it, so the window is open
today. **Any later migration that changes a native-pinned object** (for example
VAY-2057 slice E) **ends the image-only rollback window** unless the native
images are re-released with it.

What a rollback does not undo (review M4):

- Hotels created after the cutover have no native credentials and get
  `503`/`409` again until they are bootstrapped or the API rolls forward.
- An Owner switch-off made on the ordinary path carries `featureHubOwnerDisabled`,
  not the native receipt key, so the native trigger refuses to re-enable that
  row (`0449:64-67,83`). Accepted: an operator re-enables it on request.
- Profile edits replay across the cutover in both directions, because the
  ordinary writer uses the native operation name, tenant scope, key hash and
  fingerprint (review L8).

## 10. Verification plan

- Unit/route tests per slice (`vitest`, lightweight, run directly).
- Native PG16/PG17 integration tests per slice on the fixture login (A2),
  mirroring `hotelSetupProfileEdit.integration.test.ts`: foreign
  organization/property/actor, revoked Owner (membership `status='revoked'`
  between lock and write), non-Owner manager (403), stale revision, replayed
  idempotency key with identical fingerprint (no second row), different
  fingerprint (`idempotency_key_conflict`), hidden private contact
  (`private_contact_conflict`), location consent flags preserved, exactly one
  idempotency row and one audit event per success, and the fixture login never
  executes a hotel-setup definer function (`has_function_privilege` false).
- CI: the `api_postgres` matrix (`postgres: [16, 17]`, shard `hotel-setup`)
  gets one step per new suite, using the existing migrated template database.
- Local/cloud verification per the coordinator's rule: builds, heavy type checks
  and browser/E2E through `rtk proxy "$HOME/.local/bin/cloud-check" run -- <cmd>`
  (`npm --workspace vayada-api run build`, `npm run typecheck`); the PG16/PG17
  integration suites need Docker-based PostgreSQL and run through the local queue
  `rtk proxy "$HOME/.local/bin/local-check" run -- …`; never duplicate a running
  job, reconnect with `cloud-check wait JOB_ID`.
- Browser (cloud `local-check playwright` inside one job where supported):
  marketplace onboarding wizard create → logo → details → launch settings on a
  seeded local stack; identity editor save shows no error.
- `/ponytail-review` and an independent adversarial-review subagent before the
  DONE envelope (shared packages, auth and tenant boundaries are touched).

## 11. Web client impact

None required for cutover: every caller already sends `Idempotency-Key` where
the forwarder demanded it (§1), and the identity editor's second PUT starts
succeeding instead of returning 503. Two optional follow-ups, not in this
ticket: make the editor's launch-settings call best-effort (ticket comment), and
retire the `profile_edit_not_provisioned` copy from the clients once the code is
gone from the API.

## 12. Decommission list (separate PRs after the observation window)

Until step 2 below has run, the §9 rollback window rule applies: a migration
that changes any native-pinned object (§4) either ships with re-released native
images or ends the image-only rollback window.

Dependency order; each step is reversible until step 6.

1. **Public callers blocked** (platform `hotel-setup-release.yml`, `service=public`,
   `purpose=creation|property|logo|profile`, `state=blocked`): freezes the
   old image's behaviour so a rollback image can no longer silently reach the
   private services. Rollback after this step means re-enabling admission
   through the same workflow.
2. **Private services stopped** (`hotel-setup-release.yml`, `service=creation`
   and `service=property`, `state=stop`; property stop requires logo and
   profile blocked, which step 1 did). Online reconciler stays disabled
   (`HOTEL_SETUP_AUTOMATIC_PROVISIONING_ENABLED` unset, environment
   `hotel-setup-automatic-provisioning`), parked PRs #2901–#2904 closed
   unmerged.
3. **App PR: remove the native code paths** — `hotelSetupCommandServer.ts`,
   `hotelSetupCommandService.ts`, the five `hotelSetup*Commands.ts`,
   `hotelSetupCommandCredentials.ts`, `hotelSetupNativeSecretReader.ts`,
   `hotelSetupCommandScope.ts`, the seven `hotelSetup*Privileges.ts`,
   `hotelSetupLogoRuntime.ts`, `hotelSetupAutomaticDiscovery.ts`,
   `hotelSetupAutomaticReconciliation.ts`, role staging/activation/publication
   modules, `cli/hotelSetup*Preflight.ts`, `cli/hotelSetupPropertyBootstrap.ts`,
   `cli/hotelSetupAutomaticProvisioning.ts`, the forwarder module and its route
   options, `scripts/ci/check-hotel-setup-bootstrap-inventory.mjs`,
   `scripts/check-hotel-setup-image-publication.mjs`,
   `engineering/hotel-setup-bootstrap-images.json`, the `hotel-setup` CI shard
   steps that build the compatible rollback checkout, and the
   `start:hotel-setup-command` script. Requires step 2 (the preflights are the
   only consumers of the pinned digests).
4. **Platform PR: retire the caller wiring** — `hotel_setup_public_caller = off`
   in `infra/hotel_setup_staging.auto.tfvars`, relax
   `scripts/assert-hotel-setup-caller-retained.py` (+ its test) so tf-apply may
   drop the four admission/origin/token pairs, the exec-role swap
   (`vayada-next-api-setup-caller-execution`) and the caller security group
   from the next-API task; delete `hotel-setup-release.yml` and
   `release-hotel-setup.py` last in this PR. Requires step 3 (the new image
   never read the variables, so the order is safety, not correctness).
5. **Platform PR: retire the private infrastructure** — lifecycle
   `prevent_destroy` removal then deletion of `infra/hotel_setup_service.tf`,
   `hotel_setup_property_service.tf`, `hotel_setup_network.tf`,
   `hotel_setup_property_network.tf`, `hotel_setup_credentials.tf`,
   `hotel_setup_property_credentials.tf`, `hotel_setup_logo.tf`,
   `hotel_setup_creation_bootstrap.tf`, `hotel_setup_property_bootstrap.tf`,
   `hotel_setup_property_bootstrap_execution.tf`, `hotel_setup_online.tf` (+
   `.auto.tfvars.json`), `hotel_setup_container.json.tftpl`,
   `hotel_setup_secret_read_policy.json.tftpl`, `hotel_setup_staging.auto.tfvars`;
   `hotel_setup_platform_deploy.tf` only after `platform_writer_boundary.tf`
   stops consuming it. Secrets Manager entries (`hotel-setup-creation/prod/*`,
   `hotel-setup-command/prod/*` including every per-login secret) are scheduled
   for deletion, not deleted in Terraform. Workflows `hotel-setup-*.yml` (16) and
   the runner modes `--provision-hotel-setup-*`, `--stage-hotel-setup-*`,
   `--*-hotel-setup-reader-rls`, `--*-hotel-setup-legacy-helpers`,
   `--*-hotel-setup-tenant-helpers`, `--audit-hotel-setup-*`,
   `--cleanup-hotel-setup-logo`, `--repair-hotel-setup-logo-reader`,
   `--recover-hotel-setup-logo-staged-role` plus their scripts and the
   `deployment/hotel-setup-*.json` inventories; `docs/hotel-setup-*.md` moved
   to a historical section. Requires step 4.
6. **Migration PR (app): drop the native database objects** — revoke and drop
   the per-hotel logins for Animals Ahangama and Sri Journeys (every
   `vayada_next_hotel_setup_org_*`, `…_property_*`, `…_logo_*`, `…_profile_*`
   login) and the parents `vayada_next_hotel_setup_scope`,
   `…_property_scope`, `…_logo_scope`, `…_profile_scope`, the readers
   `vayada_next_hotel_setup_reader` / `…_creation_reader`; drop the scope
   tables (`platform.hotel_setup_creation_scopes`,
   `hotel_setup_property_scopes`, `hotel_setup_linked_properties`,
   `hotel_setup_reconciliation_cursors`, view
   `hotel_catalog.hotel_setup_effective_creation_scopes`), the hotel-setup
   policies, triggers and functions of `0436`–`0472` (keeping
   `creation_organization_id`, the readiness columns' data and
   `platform.tenant_scope_key` / `valid_tenant_scope` which other code uses),
   and the identity lock-only policies the VAY-2054 note deferred (adding them
   becomes possible in the same migration because nothing pins the digests any
   more). Role drops need `vayada_admin` (the migration owner cannot drop
   login roles), i.e. one last owner-checked task. Requires steps 3 and 5 and
   an updated protected list in the platform preflight (`hotel_setup_` name
   patterns can stay as a net).
7. **Cleanup**: `engineering/hotel-setup-*.md` contracts archived under a
   historical heading, Linear VAY-965/VAY-1092 closed by the human.

## 13. Decisions taken at the PLAN checkpoint (coordinator, 2026-10-08)

1. **Option A** for the definer exception list (§7): no new platform
   mechanism; the platform PR is docs-only. The existing fail-closed check is
   the exact (empty) list.
2. **Fixture parity (A2)**: the test login mirrors the platform grant list by
   hand; a platform-published JSON only if it drifts.
3. **First-currency completion (A6)** activates the default Financials
   entitlement for every new hotel exactly as the native 0448 trigger does.
4. **Launch settings (A5)** stop bumping `profile_revision`, matching the
   native writer.

An independent adversarial review of this note ran before Phase 2; its
findings are addressed in the implementation slices.

## 14. Coordinator review r1 (2026-10-08): how each item is addressed

| Item                                                                        | Where                                    |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| H1 Feature Hub safety checks, Owner-off vs suspension                       | §5 op 5, #2935                           |
| H2 explicit Owner gates per public route, `financialsSetupComplete`         | §5.1, #2931–#2935, A9                    |
| H3 creation re-check not on admin provisioning                              | §5 op 1, #2934 (regression test)         |
| H4 VAY-2055 merged; rule for later pinned-object migrations                 | §9, `main` merged into the stack         |
| M1 one wrapper: READ COMMITTED, organization `FOR UPDATE`, both owner links | §5, `hotelSetupOrdinaryScope.ts` (#2932) |
| M2 first-currency audit row and abort semantics                             | §5 op 4, #2933                           |
| M3 logo Owner-only decision, forwarding list corrected                      | §1, §5.2, A9                             |
| M4 rollback asymmetries                                                     | §9                                       |
| L1 A3 denials proven at the application layer                               | §8 A3                                    |
| L2 Feature Hub audit metadata keys as native                                | §5 op 5                                  |
| L3 admission variables no longer a kill switch                              | §9 operations note                       |
| L4 404 on a missing Booking settings row                                    | §5 op 3, #2932                           |
| L5 fixture asserts the preflight posture; VAY-2057 0.3 update               | §8 A2, #2929                             |
| L6 owner link only for a property created in this transaction               | §5 op 1, #2934                           |
| L7 one release right before the cutover deploy                              | §9 step 1                                |
| L8 cross-cutover profile replays                                            | §5 op 2, §9                              |
