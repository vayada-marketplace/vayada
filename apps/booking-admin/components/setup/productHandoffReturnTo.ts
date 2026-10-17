/** The target app's /handoff return path, carrying the hotel and organization to select. */
export function productHandoffReturnTo(
  targetPath: string,
  propertyId: string | null,
  organization: {
    organizationId: string | null;
    workosOrganizationId: string | null;
  },
): string {
  const query = new URLSearchParams({ redirect: targetPath });
  const fragment = new URLSearchParams();
  if (propertyId) fragment.set("property_id", propertyId);
  if (organization.organizationId) {
    fragment.set("organization_id", organization.organizationId);
  }
  if (organization.workosOrganizationId) {
    fragment.set("workos_organization_id", organization.workosOrganizationId);
  }
  return `/handoff?${query.toString()}${fragment.size > 0 ? `#${fragment.toString()}` : ""}`;
}
