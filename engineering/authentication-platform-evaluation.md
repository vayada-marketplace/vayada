# Authentication platform and identity model

_VAY-582 spike output. External provider details checked on 2026-06-03._

## Recommendation

Adopt **WorkOS AuthKit** as the managed authentication platform for Vayada's staff, hotel, PMS, creator, and affiliate account login flows. Keep Vayada's own auth database as the authoritative application identity and authorization layer by preserving `users.id` and adding organizations, memberships, resource links, and external identity mappings around it.

Do not make WorkOS roles or provider IDs the source of truth for product authorization. The provider should own login, sessions, enterprise SSO, MFA, passwordless/password flows, account recovery, and identity-provider lifecycle. Vayada should own which internal user can act on which hotel, creator profile, affiliate program, booking product, PMS property, and platform-admin surface.

Guest-facing booking checkout should stay out of this migration for now. If guest accounts become a product requirement later, treat them as a separate identity segment with low-friction passwordless login and no default organization membership.

## Current state

The repo already has a shared `auth-db` used by multiple products:

- `auth-db/migrations/001_auth_schema.sql` defines `users`, password reset, email verification, consent, and GDPR request tables.
- `auth-db/migrations/005_admin_2fa.sql` adds TOTP, recovery codes, login audit, and rate limiting.
- `apps/marketplace-api/app/routers/auth.py` handles local email/password registration, login, TOTP for superadmins, JWT issuance, email verification, and marketplace profile creation.
- `apps/booking-api/app/routers/auth.py` handles local hotel registration/login and sets a shared httpOnly `access_token` cookie.
- `apps/pms-api/app/dependencies.py` validates the booking-issued JWT/cookie and authorizes PMS hotel access by checking `hotels.user_id`.
- Product tables currently key ownership directly from `users.id`, such as `creators.user_id`, `hotel_profiles.user_id`, `booking_hotels.user_id`, `pms.hotels.user_id`, affiliate payout settings by `user_id`, and platform access via `users.is_superadmin`.

That means the migration should preserve internal UUIDs and should not force every product table to point at an external provider user ID.

## Candidate comparison

| Option             | Fit for Vayada                     | Strengths                                                                                                                                                                                                                                             | Risks / gaps                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkOS AuthKit     | Best fit                           | Strong B2B organization model, enterprise SSO, domain/org auth policies, MFA, passkeys, hosted UI, RBAC, audit logs, directory sync path, multiple applications sharing users/orgs. Pricing is attractive while Vayada is below enterprise SSO scale. | Less frontend-component-heavy than Clerk. Still requires internal org/resource authorization because WorkOS org membership cannot express every hotel/property/creator domain rule by itself.                                                             |
| Clerk              | Good alternative                   | Excellent Next.js developer experience, prebuilt UI, organization switcher, org invitations, roles/permissions, MFA, passkeys, satellite domains, webhooks.                                                                                           | B2B org limits/add-ons matter for hotels with more than 20 members or custom role sets. Enterprise connections are priced per connection. Provider model may pull Vayada toward Clerk-specific frontend coupling.                                         |
| Auth0              | Good but heavier                   | Mature enterprise identity platform, Organizations, RBAC per organization, SSO, MFA, logs, custom database import, broad ecosystem.                                                                                                                   | More configuration-heavy and plan-gated. Higher operational complexity for a lean rewrite unless a large enterprise customer specifically requires Auth0-style extensibility.                                                                             |
| Amazon Cognito     | Useful AWS-native fallback         | Low unit cost, AWS-native, OAuth/OIDC/SAML, MFA, managed login, Lambda triggers, Plus tier threat protections.                                                                                                                                        | Weakest product fit for first-class B2B org membership, invitations, self-serve enterprise SSO, and clean multi-app UX. More custom code would remain in Vayada.                                                                                          |
| Supabase Auth      | Not recommended for this migration | PostgreSQL ownership, standalone auth, social/password/passwordless, MFA, SAML SSO support, RLS-friendly if Vayada moved to Supabase.                                                                                                                 | Vayada is not a Supabase app. Organization/membership/RBAC would still be custom, so it does not materially reduce the hard part.                                                                                                                         |
| Keep auth in-house | Viable short term only             | Maximum data control, no vendor dependency, existing code already works for local password/JWT/TOTP flows.                                                                                                                                            | Vayada would still need to build SSO, MFA policy, invitations, organization membership, audit export, account recovery hardening, device/session management, password security, and provider lifecycle. This is not the best use of backend rewrite time. |

Sources checked: [WorkOS AuthKit](https://workos.com/docs/user-management/overview), [WorkOS users and organizations](https://workos.com/docs/user-management/users-organizations), [WorkOS organization policies](https://workos.com/docs/authkit/organization-policies), [WorkOS RBAC](https://workos.com/docs/rbac/integration), [WorkOS pricing](https://workos.com/pricing), [Clerk organizations](https://clerk.com/docs/guides/force-organizations), [Clerk roles and permissions](https://clerk.com/docs/organizations/create-roles-permissions), [Clerk pricing](https://clerk.com/pricing), [Auth0 Organizations](https://auth0.com/docs/organizations), [Auth0 pricing](https://auth0.com/pricing/), [Amazon Cognito managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-hosted-ui-user-experience.html), [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/), [Supabase Auth](https://supabase.com/docs/guides/auth/), [Supabase SAML SSO](https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml), and [Supabase pricing](https://supabase.com/pricing).

## Proposed identity model

### Core tables

Keep `users.id` as the stable internal principal ID and evolve the auth DB around it:

- `users`: internal person/account record. Keep `id`, `email`, `name`, `status`, consent fields, and timestamps. Replace the single-purpose `type` column over time with derived memberships and product roles; keep it during migration for compatibility.
- `external_identities`: maps `users.id` to provider identities. Suggested columns: `provider`, `provider_user_id`, `provider_email`, `provider_email_verified`, `last_login_at`, `raw_profile`, `created_at`, `updated_at`. Unique on `(provider, provider_user_id)`.
- `organizations`: internal tenant/business container. Suggested columns: `id`, `kind`, `name`, `slug`, `status`, `external_provider_org_id`, `created_at`, `updated_at`.
- `organization_memberships`: user-to-org relationship. Suggested columns: `organization_id`, `user_id`, `role_key`, `status`, `invited_by_user_id`, `external_provider_membership_id`, `created_at`, `updated_at`. Unique on `(organization_id, user_id)`.
- `organization_resource_links`: maps an org to product resources. Suggested columns: `organization_id`, `product`, `resource_type`, `resource_id`, `relationship`.
- `invitations`: internal invite intent and audit record, even if the provider sends the email. Suggested columns: `organization_id`, `email`, `role_key`, `invited_by_user_id`, `provider_invitation_id`, `status`, `expires_at`, `accepted_at`.
- `app_audit_events`: application-level actions after authentication, separate from provider login/audit events.

### Organization kinds

- `platform`: Vayada internal staff organization.
- `hotel_group`: hotel business account. Owns booking and PMS hotel/property records and marketplace hotel profiles/listings.
- `creator`: creator business or solo creator workspace.
- `affiliate_partner`: affiliate account or agency workspace.

Start with one organization per current user-owned business and allow one user to belong to many organizations. This fixes the current limitation where a single `users.type` implies one product role forever.

### Resource ownership

Treat organizations as the authorization boundary and product records as resources:

- Marketplace `hotel_profiles` and `hotel_listings` link to a `hotel_group` organization.
- Booking `booking_hotels` link to a `hotel_group` organization.
- PMS `hotels` link to a `hotel_group` organization.
- Marketplace `creators` link to a `creator` organization.
- PMS/booking affiliate records link to an `affiliate_partner` organization and, when relevant, to the hotel organization they promote.

Keep existing `user_id` columns during migration. New authorization checks should resolve `user -> active organization -> linked resources`. Later migrations can deprecate direct owner-only assumptions.

### Roles

Use provider roles only as a coarse mirror for session claims. Enforce product permissions internally.

Suggested internal roles:

- Platform: `platform_owner`, `platform_admin`, `support`, `finance`, `content_review`.
- Hotel: `hotel_owner`, `hotel_admin`, `pms_manager`, `booking_manager`, `front_desk`, `finance`, `marketing`.
- Creator: `creator_owner`, `creator_manager`, `creator_contributor`.
- Affiliate: `affiliate_owner`, `affiliate_manager`, `affiliate_member`.

Permissions should be named by product action, for example `pms.booking.update`, `booking.settings.manage`, `marketplace.collaboration.review`, and `platform.user.suspend`. A role is just a bundle of permissions on a membership.

## Product behavior

- Vayada admins: require managed auth plus mandatory MFA. Platform authorization comes from `platform` org membership and `platform_*` roles, not only `users.is_superadmin`.
- Hotel staff, booking admins, and PMS users: authenticate through the same provider; choose an active hotel organization after login if they have multiple memberships. Require MFA for owners/admins and allow enforcement per hotel org.
- Creators: authenticate through the provider, typically with a personal `creator` organization. Support multiple members later without changing the model.
- Affiliates: authenticate through the provider only for the affiliate dashboard and payout settings. Public affiliate signup and referral clicks can remain guest/public flows until approved affiliates are invited or linked to accounts.
- Guests: keep checkout unauthenticated. Store guest identity on bookings as booking/customer data, not as auth users, unless a future guest portal is explicitly scoped.

## Migration path

1. Add provider-neutral identity schema in `auth-db`: `external_identities`, `organizations`, `organization_memberships`, `organization_resource_links`, `invitations`, and `app_audit_events`.
2. Backfill organizations and memberships from existing data:
   - Create the Vayada platform org and memberships for `is_superadmin`.
   - Create hotel organizations from marketplace hotel profiles, booking hotels, and PMS hotels.
   - Create creator organizations from `creators`.
   - Create affiliate organizations for approved/account-backed affiliates.
   - Add owner memberships from each existing `user_id`.
3. Add a provider integration behind the current API contract:
   - Provider callback finds or creates `users` by verified email.
   - Link `external_identities`.
   - Issue the current internal JWT/cookie for product APIs during the transition.
4. Move one frontend at a time to hosted login or provider session exchange, starting with Vayada admin and booking/PMS admin surfaces. Marketplace creator/hotel auth can follow once profile creation is adapted.
5. Replace local password reset, email verification, and TOTP flows with provider flows for migrated users. Keep local password login temporarily for rollback and old users not yet linked.
6. Turn registration into a post-auth onboarding flow that creates the right internal organization/resource records after a verified provider identity exists.
7. Enforce membership-based authorization in shared dependencies and repositories. Keep `users.type` and direct `user_id` checks until each product surface is migrated.
8. Disable new local password credentials, then remove or archive `password_hash`, local reset tokens, and local TOTP tables only after all active users are linked and rollback is no longer needed.

## Follow-up ticket drafts

### Add provider-neutral identity tables

Labels: `Backend`, `Platform`, `Feature`

Expected scope:

- Add auth DB migrations for external identities, organizations, memberships, resource links, invitations, and app audit events.
- Keep `users.id` as the internal principal.
- Add repository helpers and focused tests for create/link/lookup behavior.

### Backfill organizations and memberships

Labels: `Backend`, `Platform`, `Chore`

Expected scope:

- Create a backfill script that derives organizations and owner memberships from current users, marketplace profiles, booking hotels, PMS hotels, creators, and affiliates.
- Make the script idempotent.
- Produce a dry-run report before writing changes.

### Integrate WorkOS AuthKit behind internal sessions

Labels: `Backend`, `Platform`, `Feature`

Expected scope:

- Add provider configuration, callback handling, user linking, and internal JWT/cookie issuance.
- Support existing local-login rollback during rollout.
- Persist external identity mappings and provider org IDs where present.

### Migrate admin and hotel frontends to managed login

Labels: `Frontend`, `Platform`, `Feature`

Expected scope:

- Replace local login/register surfaces in Vayada admin, booking admin/web, PMS web, and affiliate dashboard with the selected provider login flow or session exchange.
- Preserve the existing local user display state and product redirects.
- Verify cookie/bearer behavior across portless local domains.

### Implement membership-based authorization

Labels: `Backend`, `Platform`, `Improvement`

Expected scope:

- Add shared authorization helpers for active organization, role, permission, and linked-resource checks.
- Migrate PMS, booking admin, marketplace hotel, creator, affiliate, and platform-admin checks away from direct `users.type` and owner-only `user_id` assumptions.
- Add audit events for privileged actions.

### Replace local account recovery and MFA

Labels: `Backend`, `Platform`, `Chore`

Expected scope:

- Switch password reset, email verification, TOTP, and recovery-code flows to the selected provider for migrated users.
- Define the retirement plan for local reset/TOTP tables.
- Keep compatibility for not-yet-linked users until the migration is complete.

## Decision checkpoints

Before implementation starts, confirm:

- Whether WorkOS is accepted as the provider of record.
- Whether hotel organizations should map to one legal hotel business, one property, or a hotel group with multiple properties. The proposed default is hotel group with linked property resources.
- Whether creator and affiliate workspaces need multi-member support immediately or only model compatibility.
- Which frontend should migrate first. Recommended first surface: Vayada admin, then booking/PMS hotel admin.
