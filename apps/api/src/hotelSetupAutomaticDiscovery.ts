import { createHash } from "node:crypto";
import type pg from "pg";
import { hotelSetupOrganizationRolePrefix } from "./hotelSetupOrganizationRoleStaging.js";

export type HotelSetupAutomaticMode = "organization" | "property";
export type HotelSetupAutomaticCandidate = {
  scopeId: string;
  organizationId: string;
  actorUserId: string;
};
export const HOTEL_SETUP_AUTOMATIC_PURPOSES = [
  "launch_settings",
  "currency_ready",
  "feature_hub",
] as const;
export type HotelSetupAutomaticPurpose = (typeof HOTEL_SETUP_AUTOMATIC_PURPOSES)[number];

/** Cursor includes the actor: an ineligible earlier membership cannot starve a later Owner.
 * These current canonical rows are discovery hints; helpers lock effective authority again. */
export async function discoverHotelSetupAutomaticCandidates(
  admin: pg.Client,
  mode: HotelSetupAutomaticMode,
) {
  const cursor = await admin.query(
    "SELECT scope_id,organization_id,actor_user_id FROM platform.hotel_setup_reconciliation_cursors WHERE mode=$1",
    [mode],
  );
  if (cursor.rows.length !== 1) throw new Error();
  const position = cursor.rows[0]!;
  const property = mode === "property";
  const result = await admin.query<HotelSetupAutomaticCandidate>(
    `SELECT DISTINCT ${property ? "property.id" : "organization.id"}::text AS "scopeId",
      organization.id::text AS "organizationId", member.user_id::text AS "actorUserId"
     FROM identity.organizations organization
     JOIN identity.organization_memberships member ON member.organization_id=organization.id AND member.status='active'
     JOIN identity.users actor ON actor.id=member.user_id AND actor.status='active'
     ${
       property
         ? `JOIN identity.organization_resource_links catalog ON catalog.organization_id=organization.id
       AND catalog.product='hotel_catalog' AND catalog.resource_type='property'
       AND catalog.relationship='owner' AND catalog.status='active'
     JOIN hotel_catalog.properties property ON lower(catalog.resource_id)=property.id::text
     JOIN identity.organization_resource_links pms ON pms.organization_id=organization.id
       AND pms.product='pms' AND pms.resource_type='pms_property' AND lower(pms.resource_id)=property.id::text
       AND pms.relationship='owner' AND pms.status='active'
     JOIN hotel_catalog.organization_setup_track_intents intent ON intent.organization_id=organization.id
       AND 'hotel_operations'=ANY(intent.selected_tracks)`
         : ""
     }
     WHERE organization.kind='hotel_group' AND organization.status='active'
       ${property ? "AND member.pms_access_enabled AND member.booking_access_enabled" : ""}
       AND ($1::uuid IS NULL OR (${property ? "property.id" : "organization.id"},organization.id,member.user_id)
         > ($1::uuid,$2::uuid,$3::uuid))
     ORDER BY "scopeId","organizationId","actorUserId" LIMIT 2`,
    [position.scope_id, position.organization_id, position.actor_user_id],
  );
  return result.rows;
}

/** Advance before side effects. A crash may defer this candidate until the next wrap;
 * committed assignments/prefixes still prevent retry or adoption of a partial attempt. */
export async function advanceHotelSetupAutomaticCursor(
  admin: pg.Client,
  mode: HotelSetupAutomaticMode,
  candidate?: HotelSetupAutomaticCandidate,
) {
  const result = await admin.query(
    `UPDATE platform.hotel_setup_reconciliation_cursors SET scope_id=$2::uuid,
      organization_id=$3::uuid,actor_user_id=$4::uuid,updated_at=clock_timestamp() WHERE mode=$1`,
    [
      mode,
      candidate?.scopeId ?? null,
      candidate?.organizationId ?? null,
      candidate?.actorUserId ?? null,
    ],
  );
  if (result.rowCount !== 1) throw new Error();
}

/** Existing identities are read only: never adopt, rotate, transfer or repair them. */
export async function inspectHotelSetupAutomaticIdentity(
  admin: pg.Client,
  candidate: HotelSetupAutomaticCandidate,
  purpose?: HotelSetupAutomaticPurpose,
): Promise<"fresh" | "existing_ready" | "inspection_required"> {
  const property = purpose !== undefined;
  const assignment = await admin.query<{ ready: boolean }>(
    `SELECT (scope.organization_id=$1::uuid ${property ? "AND scope.active" : ""}
      AND scope.credential_role_oid=role.oid AND role.rolcanlogin
      AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL) IS TRUE AS ready
     FROM platform.${property ? "hotel_setup_property_scopes" : "hotel_setup_creation_scopes"} scope
     LEFT JOIN pg_catalog.pg_roles role ON role.rolname=scope.database_login
     WHERE ${property ? "scope.property_id=$2::uuid AND scope.operation_class=$3" : "scope.organization_id=$1::uuid"}`,
    property ? [candidate.organizationId, candidate.scopeId, purpose] : [candidate.organizationId],
  );
  if (assignment.rows.length)
    return assignment.rows.length === 1 && assignment.rows[0]?.ready === true
      ? "existing_ready"
      : "inspection_required";
  const prefix = property
    ? `vayada_next_hotel_setup_property_${createHash("sha256").update(`${candidate.scopeId}:${purpose}`).digest("hex").slice(0, 16)}_`
    : hotelSetupOrganizationRolePrefix(candidate.organizationId);
  const staged = await admin.query(
    "SELECT oid FROM pg_catalog.pg_roles WHERE pg_catalog.left(rolname::text,length($1))=$1",
    [prefix],
  );
  return staged.rows.length ? "inspection_required" : "fresh";
}
