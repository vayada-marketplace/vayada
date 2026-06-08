import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

const IDENTITY_UNIQUENESS_CHECKS = [
  "external_identities",
  "organization_memberships",
  "organization_resource_links",
  "product_entitlements",
  "source_external_identities",
  "source_organization_memberships",
  "source_organization_resource_links",
] as const;

const ALLOWED_IDENTITY_UNIQUENESS_CHECKS = new Set<string>(IDENTITY_UNIQUENESS_CHECKS);

function validateIdentityUniquenessChecks(
  checks: string[] | undefined,
  findings: ParityFinding[],
): boolean {
  if (!checks) return true;

  let isValid = true;
  for (const check of checks) {
    if (ALLOWED_IDENTITY_UNIQUENESS_CHECKS.has(check)) continue;

    isValid = false;
    findings.push({
      severity: "fail",
      code: "INVALID_FIXTURE_CONFIG",
      owner: "Parity harness",
      targetObject: "expected-target.json",
      message: `Unknown uniquenessChecks entry: ${check}`,
      expected: `One of: ${IDENTITY_UNIQUENESS_CHECKS.join(", ")}`,
      actual: check,
      suggestedAction: "Fix uniquenessChecks in expected-target.json.",
    });
  }

  return isValid;
}

// Identity-domain uniqueness checks. These mirror the constraints in the
// identity DDL and catch source ambiguity before future product transforms
// silently choose a tenant/resource owner.
async function checkIdentityUniqueness(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.uniquenessChecks;
  const runAll = !checks;
  if (!validateIdentityUniquenessChecks(checks, findings)) return;

  if (runAll || checks.includes("external_identities")) {
    const extIdDupes = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT provider, provider_user_id
        FROM identity.external_identities
        WHERE provider_user_id IS NOT NULL
        GROUP BY provider, provider_user_id
        HAVING count(*) > 1
      ) AS dupes
    `);
    if (parseInt(extIdDupes.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "UNIQUENESS_VIOLATION",
        owner: "Identity/auth",
        targetObject: "identity.external_identities",
        message: "Duplicate (provider, provider_user_id) pairs found",
        expected: "0 duplicate pairs",
        actual: `${extIdDupes.rows[0].count} duplicate pair(s)`,
        suggestedAction: "Deduplicate source external identity rows before migration.",
      });
    }
  }

  if (runAll || checks.includes("organization_memberships")) {
    const membershipDupes = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT organization_id, user_id
        FROM identity.organization_memberships
        GROUP BY organization_id, user_id
        HAVING count(*) > 1
      ) AS dupes
    `);
    if (parseInt(membershipDupes.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "UNIQUENESS_VIOLATION",
        owner: "Identity/auth",
        targetObject: "identity.organization_memberships",
        message: "Duplicate (organization_id, user_id) pairs found in memberships",
        expected: "0 duplicate pairs",
        actual: `${membershipDupes.rows[0].count} duplicate pair(s)`,
        suggestedAction: "Deduplicate membership rows before migration.",
      });
    }
  }

  if (runAll || checks.includes("organization_resource_links")) {
    const resourceLinkDupes = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT organization_id, product, resource_type, resource_id, relationship
        FROM identity.organization_resource_links
        GROUP BY organization_id, product, resource_type, resource_id, relationship
        HAVING count(*) > 1
      ) AS dupes
    `);
    if (parseInt(resourceLinkDupes.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "UNIQUENESS_VIOLATION",
        owner: "Identity/auth",
        targetObject: "identity.organization_resource_links",
        message: "Duplicate organization resource links found",
        expected: "0 duplicate links",
        actual: `${resourceLinkDupes.rows[0].count} duplicate link(s)`,
        suggestedAction: "Deduplicate source ownership rows before migration.",
      });
    }
  }

  if (runAll || checks.includes("product_entitlements")) {
    const entitlementDupes = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT
          organization_id,
          product,
          entitlement_key,
          COALESCE(resource_product, '') AS resource_product,
          COALESCE(resource_type, '') AS resource_type,
          COALESCE(resource_id, '') AS resource_id
        FROM identity.product_entitlements
        GROUP BY
          organization_id,
          product,
          entitlement_key,
          COALESCE(resource_product, ''),
          COALESCE(resource_type, ''),
          COALESCE(resource_id, '')
        HAVING count(*) > 1
      ) AS dupes
    `);
    if (parseInt(entitlementDupes.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "UNIQUENESS_VIOLATION",
        owner: "Identity/auth",
        targetObject: "identity.product_entitlements",
        message: "Duplicate product entitlement scopes found",
        expected: "0 duplicate entitlement scopes",
        actual: `${entitlementDupes.rows[0].count} duplicate scope(s)`,
        suggestedAction: "Deduplicate entitlement source rows before migration.",
      });
    }
  }

  if (runAll || checks.includes("source_external_identities")) {
    const sourceExtIdDupes = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT workos_user_id
        FROM migration_source_auth.users
        WHERE workos_user_id IS NOT NULL
        GROUP BY workos_user_id
        HAVING count(*) > 1
      ) AS dupes
    `);
    if (parseInt(sourceExtIdDupes.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "SOURCE_EXTERNAL_IDENTITY_DUPLICATE",
        owner: "Identity/auth",
        targetObject: "migration_source_auth.users",
        message: "Duplicate source WorkOS user IDs found",
        expected: "0 duplicate WorkOS user IDs",
        actual: `${sourceExtIdDupes.rows[0].count} duplicate WorkOS user ID(s)`,
        suggestedAction: "Resolve duplicated source identity provider IDs before migration.",
      });
    }
  }

  if (runAll || checks.includes("source_organization_memberships")) {
    const sourceMembershipAmbiguity = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT organization_id, user_id
        FROM migration_source_auth.identity_organization_links
        GROUP BY organization_id, user_id
        HAVING count(DISTINCT ROW(role_key, membership_status, COALESCE(workos_membership_id, ''))) > 1
      ) AS ambiguous
    `);
    if (parseInt(sourceMembershipAmbiguity.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "SOURCE_MEMBERSHIP_AMBIGUOUS",
        owner: "Identity/auth",
        targetObject: "migration_source_auth.identity_organization_links",
        message:
          "Source membership rows map one user and organization to conflicting membership attributes",
        expected: "One role/status/membership identity per organization and user",
        actual: `${sourceMembershipAmbiguity.rows[0].count} ambiguous membership group(s)`,
        suggestedAction: "Resolve conflicting membership source rows before migration.",
      });
    }
  }

  if (runAll || checks.includes("source_organization_resource_links")) {
    const sourceResourceDupes = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT organization_id, product, resource_type, resource_id, relationship
        FROM migration_source_auth.identity_organization_links
        GROUP BY organization_id, product, resource_type, resource_id, relationship
        HAVING count(*) > 1
      ) AS dupes
    `);
    if (parseInt(sourceResourceDupes.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "SOURCE_RESOURCE_LINK_DUPLICATE",
        owner: "Identity/auth",
        targetObject: "migration_source_auth.identity_organization_links",
        message: "Duplicate source organization resource-link rows found",
        expected: "0 duplicate source resource links",
        actual: `${sourceResourceDupes.rows[0].count} duplicate source link(s)`,
        suggestedAction: "Deduplicate source ownership rows before migration.",
      });
    }

    const sourceResourceAmbiguity = await client.query<{ count: string }>(`
      SELECT count(*)::text FROM (
        SELECT product, resource_type, resource_id, relationship
        FROM migration_source_auth.identity_organization_links
        GROUP BY product, resource_type, resource_id, relationship
        HAVING count(DISTINCT organization_id) > 1
      ) AS ambiguous
    `);
    if (parseInt(sourceResourceAmbiguity.rows[0].count, 10) > 0) {
      findings.push({
        severity: "fail",
        code: "SOURCE_RESOURCE_LINK_AMBIGUOUS",
        owner: "Identity/auth",
        targetObject: "migration_source_auth.identity_organization_links",
        message:
          "Source resource ownership maps the same product resource relationship to multiple organizations",
        expected: "One authoritative organization per product resource relationship",
        actual: `${sourceResourceAmbiguity.rows[0].count} ambiguous source link group(s)`,
        suggestedAction: "Pick the authoritative organization before migrating this resource link.",
      });
    }
  }
}

async function checkIdentityFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.identityChecks;
  if (!checks) return;

  for (const membership of checks.memberships ?? []) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM identity.organization_memberships
         WHERE organization_id = $1
           AND user_id = $2
           AND status = $3
           AND role_key = $4
       ) AS exists`,
      [membership.organizationId, membership.userId, membership.status, membership.roleKey],
    );
    if (!result.rows[0].exists) {
      findings.push({
        severity: "fail",
        code: "IDENTITY_MEMBERSHIP_MISMATCH",
        owner: "Identity/auth",
        targetObject: "identity.organization_memberships",
        message: `Expected membership ${membership.userId} -> ${membership.organizationId} was not found`,
        expected: JSON.stringify(membership),
        actual: "Row not found",
        suggestedAction: "Check source ownership rows and membership transform logic.",
      });
    }
  }

  for (const link of checks.resourceLinks ?? []) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM identity.organization_resource_links
         WHERE organization_id = $1
           AND product = $2
           AND resource_type = $3
           AND resource_id = $4
           AND relationship = $5
           AND status = $6
       ) AS exists`,
      [
        link.organizationId,
        link.product,
        link.resourceType,
        link.resourceId,
        link.relationship,
        link.status,
      ],
    );
    if (!result.rows[0].exists) {
      findings.push({
        severity: "fail",
        code: "IDENTITY_RESOURCE_LINK_MISMATCH",
        owner: "Identity/auth",
        targetObject: "identity.organization_resource_links",
        message: `Expected ${link.product}.${link.resourceType}:${link.resourceId} ${link.relationship} link was not found`,
        expected: JSON.stringify(link),
        actual: "Row not found",
        suggestedAction: "Check legacy ownership source rows and resource-link transform logic.",
      });
    }
  }

  for (const entitlement of checks.entitlements ?? []) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM identity.product_entitlements
         WHERE organization_id = $1
           AND product = $2
           AND entitlement_key = $3
           AND status = $4
           AND resource_product IS NOT DISTINCT FROM $5::text
           AND resource_type IS NOT DISTINCT FROM $6::text
           AND resource_id IS NOT DISTINCT FROM $7::text
       ) AS exists`,
      [
        entitlement.organizationId,
        entitlement.product,
        entitlement.entitlementKey,
        entitlement.status,
        entitlement.resourceProduct,
        entitlement.resourceType,
        entitlement.resourceId,
      ],
    );
    if (!result.rows[0].exists) {
      findings.push({
        severity: "fail",
        code: "IDENTITY_ENTITLEMENT_MISMATCH",
        owner: "Identity/auth",
        targetObject: "identity.product_entitlements",
        message: `Expected ${entitlement.product}.${entitlement.entitlementKey} entitlement was not found`,
        expected: JSON.stringify(entitlement),
        actual: "Row not found",
        suggestedAction: "Check source entitlement rows and entitlement transform logic.",
      });
    }
  }

  for (const grant of checks.rolePermissionGrants ?? []) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM identity.role_permission_grants
         WHERE organization_kind = $1
           AND role_key = $2
           AND permission_key = $3
       ) AS exists`,
      [grant.organizationKind, grant.roleKey, grant.permissionKey],
    );
    if (!result.rows[0].exists) {
      findings.push({
        severity: "fail",
        code: "IDENTITY_ROLE_GRANT_MISSING",
        owner: "Identity/auth",
        targetObject: "identity.role_permission_grants",
        message: `Expected ${grant.organizationKind}.${grant.roleKey} to grant ${grant.permissionKey}`,
        expected: JSON.stringify(grant),
        actual: "Grant not found",
        suggestedAction: "Check identity role grant seed migrations.",
      });
    }
  }

  for (const permissionKey of checks.permissionKeys ?? []) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM identity.permission_catalog WHERE key = $1
       ) AS exists`,
      [permissionKey],
    );
    if (!result.rows[0].exists) {
      findings.push({
        severity: "fail",
        code: "IDENTITY_PERMISSION_MISSING",
        owner: "Identity/auth",
        targetObject: "identity.permission_catalog",
        message: `Expected permission key ${permissionKey} was not found`,
        expected: permissionKey,
        actual: "Permission key not found",
        suggestedAction: "Check identity permission seed migrations.",
      });
    }
  }
}

export async function checkIdentityOrganizationLinksParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkIdentityUniqueness(client, expected, findings);
  await checkIdentityFixtures(client, expected, findings);
}
