# Atomic first hotel Save — VAY-965

> **Superseded by VAY-2056** ([ordinary login](hotel-setup-ordinary-login.md)): the atomic first Save runs on the ordinary login with the Owner-mode creation repository.
> This contract describes the private services, which stay until the decommission steps.

Both reported Owners have no linked property. The wizard currently creates a
property, then PUTs launch settings before reloading status. That second command
requires a property-purpose credential which cannot be staged before the property
exists. A successful first Save must not depend on that operational handoff.

For persisted Hotel Operations selection, the create request may include
`initialLaunchSettings`, using the existing four
booking localization fields and four explicitly entered public social URLs.
Creator-only setup shows its basic profile fields, not booking launch fields;
reject a supplied initial-settings payload without locked Hotel Operations authority.
Validate this payload with the launch-settings contract and include its normalized
values in the creation idempotency fingerprint. The existing creation audit binds
that fingerprint through its idempotency key without publishing raw settings. Store the profile, initial
settings and sanitized audit receipt in one transaction. A failed settings insert
must leave no property, links, contacts or completed creation receipt.

Extend the creation login only with INSERT on the four booking localization
columns. Existing RLS must continue requiring a property created in the current
transaction under its assigned organization and active booking owner link.
Social inserts reuse creation's new-property contact boundary, preserve private
contacts and use the booking source. There is no pre-existing public projection
for a new UUID to rewrite. No UPDATE, pricing currency, Financials, role creation,
credential publication or product activation permission is added.

This narrowly extends the creation boundary in
[the launch-settings contract](hotel-setup-launch-settings-command.md). Existing
property edits retain its native property-purpose command. After an atomic create,
the wizard omits the redundant PUT; status reload and optional media still follow.
Retries must reuse the same creation key, reject changed initial settings and avoid
a second property even when a later reload fails.

Required proof: nondefault LKR/localization and explicit social URLs; omitted
payload compatibility; invalid fields and publication denial; replay/conflict;
transaction rollback; native old/foreign-row INSERT and UPDATE denial on PG16/17;
the actual first-Save/reload path and existing-property PUT preservation.
