-- VAY-2079 R2: drop the direct-booking pricing authority.
--
-- Public pricing no longer reads a staff "price source" choice (VAY-2079 R1: #2996, #3004).
-- The owning organization comes from identity.organization_resource_links, and a current
-- publication makes prices public. Since R1 nothing reads or writes these objects.
--
-- Rollback: only to an image at or after R1 (ab785ee6b). Older images read
-- booking.pricing_authority_heads and fail closed. Platform P1 (vayada-platform #488) must be
-- applied first, so the identity runtime grant accepts the missing view.
--
-- Kept:
--   platform.pricing_runtime_property_scopes and booking.pricing_runtime_effective_property_scopes (0409)
--   platform.prevent_append_only_mutation(), shared by other append-only tables
--
-- Order without CASCADE: the heads policies (0409) read the authority-scope view, and the view
-- reads the revisions table. Dropping a table also drops its policies and triggers.
DROP TABLE booking.pricing_authority_heads;
DROP VIEW booking.pricing_runtime_effective_authority_scopes;
DROP TABLE booking.pricing_authority_revisions;
