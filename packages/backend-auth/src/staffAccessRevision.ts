import { createHash } from "node:crypto";

export type StaffAccessRevisionRow = {
  id: string;
  role_definition_id: string | null;
  role_definition: unknown;
  pms_access_enabled: boolean;
  booking_access_enabled: boolean;
  role_key: string;
  status: string;
  access_origin: string;
  updated_at: string;
  property_access_mode: string;
  property_ids: string[];
  permission_overrides: unknown;
  role_permissions: string[];
};

export function staffAccessRevision(row: StaffAccessRevisionRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: row.id,
        roleDefinitionId: row.role_definition_id,
        roleDefinition: row.role_definition,
        productAccess: { pms: row.pms_access_enabled, booking: row.booking_access_enabled },
        role: row.role_key,
        status: row.status,
        origin: row.access_origin,
        updatedAt: row.updated_at,
        mode: row.property_access_mode,
        properties: row.property_ids,
        overrides: row.permission_overrides,
        rolePermissions: row.role_permissions,
      }),
    )
    .digest("hex");
}
