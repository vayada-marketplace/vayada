import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

import { type MigrationEnvironment } from "./runner.js";

export type ParityCheckSeverity = "fail" | "warn";

export type ParityFinding = {
  severity: ParityCheckSeverity;
  code: string;
  owner: string;
  targetObject: string;
  message: string;
  expected: string;
  actual: string;
  suggestedAction?: string;
};

export type ParityReport = {
  runId: string;
  environment: string;
  fixtureCase: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  summary: {
    failures: number;
    warnings: number;
  };
  findings: ParityFinding[];
};

export type ParityConfig = {
  connectionString: string;
  fixtureCase: string;
  fixturesDir: string;
  environment: MigrationEnvironment;
};

type ExpectedTarget = {
  counts: Record<string, number>;
  idStability: Record<string, string[]>;
  uniquenessChecks?: string[];
  identityChecks?: {
    memberships?: Array<{
      organizationId: string;
      userId: string;
      status: string;
      roleKey: string;
    }>;
    resourceLinks?: Array<{
      organizationId: string;
      product: string;
      resourceType: string;
      resourceId: string;
      relationship: string;
      status: string;
    }>;
    entitlements?: Array<{
      organizationId: string;
      product: string;
      entitlementKey: string;
      status: string;
      resourceProduct: string | null;
      resourceType: string | null;
      resourceId: string | null;
    }>;
    rolePermissionGrants?: Array<{
      organizationKind: string;
      roleKey: string;
      permissionKey: string;
    }>;
    permissionKeys?: string[];
  };
  catalogPublicProfileChecks?: {
    completePropertyIds?: string[];
    missingLocationPropertyIds?: string[];
    customDomainProperties?: Array<{
      propertyId: string;
      hostname: string;
    }>;
    forbiddenPublicProfileKeys?: string[];
  };
};

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseTableRef(
  tableRef: string,
  findings: ParityFinding[],
): { schema: string; table: string } | null {
  const parts = tableRef.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !SAFE_IDENTIFIER.test(parts[0]) ||
    !SAFE_IDENTIFIER.test(parts[1])
  ) {
    findings.push({
      severity: "fail",
      code: "INVALID_FIXTURE_CONFIG",
      owner: "Parity harness",
      targetObject: tableRef,
      message: `Malformed table reference "${tableRef}" in expected-target.json — expected "schema.table"`,
      expected: "schema.table",
      actual: tableRef,
      suggestedAction: `Fix the table reference in expected-target.json.`,
    });
    return null;
  }
  return { schema: parts[0], table: parts[1] };
}

async function checkRowCounts(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, expectedCount] of Object.entries(expected.counts)) {
    const ref = parseTableRef(tableRef, findings);
    if (!ref) continue;

    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM "${ref.schema}"."${ref.table}"`,
    );
    const actual = parseInt(result.rows[0].count, 10);
    if (actual !== expectedCount) {
      findings.push({
        severity: "fail",
        code: "ROW_COUNT_MISMATCH",
        owner: "Identity/auth",
        targetObject: tableRef,
        message: `Row count mismatch for ${tableRef}`,
        expected: String(expectedCount),
        actual: String(actual),
        suggestedAction: "Check fixture source rows and transform logic.",
      });
    }
  }
}

async function checkIdStability(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, ids] of Object.entries(expected.idStability)) {
    const ref = parseTableRef(tableRef, findings);
    if (!ref) continue;

    for (const id of ids) {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM "${ref.schema}"."${ref.table}" WHERE id = $1) AS exists`,
        [id],
      );
      if (!result.rows[0].exists) {
        findings.push({
          severity: "fail",
          code: "ID_STABILITY_VIOLATION",
          owner: "Identity/auth",
          targetObject: tableRef,
          message: `Source ID ${id} not found in ${tableRef} — ID was not preserved`,
          expected: `Row with id = ${id}`,
          actual: "Row not found",
          suggestedAction: "Verify the ETL transform preserves source primary key values.",
        });
      }
    }
  }
}

// Identity-domain uniqueness checks. Checks (provider, provider_user_id) uniqueness
// in external_identities and (organization_id, user_id) uniqueness in memberships.
// These mirror the constraints in 0001_identity.sql and catch data that bypassed
// constraints during a legacy migration or pg_restore with deferred constraints.
// Only runs the checks listed in expected.uniquenessChecks; runs all if the field is absent.
async function checkUniqueness(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.uniquenessChecks;
  const runAll = !checks;

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

async function checkCatalogPublicProfileFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.catalogPublicProfileChecks;
  if (!checks) return;

  for (const propertyId of checks.completePropertyIds ?? []) {
    const result = await client.query<{ profile_status: string; completeness_reasons: string[] }>(
      `SELECT profile_status, completeness_reasons
       FROM hotel_catalog.property_public_profile_read_model
       WHERE property_id = $1`,
      [propertyId],
    );
    const row = result.rows[0];
    if (!row || row.profile_status !== "complete" || row.completeness_reasons.length !== 0) {
      findings.push({
        severity: "fail",
        code: "CATALOG_PROFILE_COMPLETENESS_MISMATCH",
        owner: "Hotel/property catalog",
        targetObject: "hotel_catalog.property_public_profile_read_model",
        message: `Expected property ${propertyId} to be complete with no completeness reasons`,
        expected: "profile_status=complete, completeness_reasons={}",
        actual: row
          ? `profile_status=${row.profile_status}, completeness_reasons=${row.completeness_reasons.join(",")}`
          : "row missing",
        suggestedAction: "Check catalog backfill/profile projection rules for complete properties.",
      });
    }
  }

  for (const propertyId of checks.missingLocationPropertyIds ?? []) {
    const result = await client.query<{
      profile_status: string;
      completeness_reasons: string[];
      location: Record<string, unknown>;
    }>(
      `SELECT profile_status, completeness_reasons, location
       FROM hotel_catalog.property_public_profile_read_model
       WHERE property_id = $1`,
      [propertyId],
    );
    const row = result.rows[0];
    const location = row?.location ?? {};
    const hasStructuredLocation = ["countryCode", "city", "timezone", "geo"].some(
      (key) => location[key] != null,
    );
    if (
      !row ||
      row.profile_status !== "incomplete" ||
      !row.completeness_reasons.includes("location_unverified") ||
      !row.completeness_reasons.includes("timezone_missing") ||
      hasStructuredLocation
    ) {
      findings.push({
        severity: "fail",
        code: "CATALOG_MISSING_LOCATION_FIXTURE_MISMATCH",
        owner: "Hotel/property catalog",
        targetObject: "hotel_catalog.property_public_profile_read_model",
        message: `Expected property ${propertyId} to preserve missing-location semantics`,
        expected:
          "incomplete profile with location_unverified/timezone_missing and no structured location",
        actual: row ? JSON.stringify(row) : "row missing",
        suggestedAction:
          "Keep ambiguous Marketplace location as raw evidence until structured fields are confirmed.",
      });
    }
  }

  for (const expectedDomain of checks.customDomainProperties ?? []) {
    const result = await client.query<{
      hostname: string | null;
      property_domain_id: string | null;
      verification_status: string | null;
      canonical_when_verified: boolean | null;
    }>(
      `SELECT rm.verified_custom_domain AS hostname,
              rm.property_domain_id,
              d.verification_status,
              d.canonical_when_verified
       FROM hotel_catalog.property_public_profile_read_model rm
       LEFT JOIN hotel_catalog.property_domains d ON d.id = rm.property_domain_id
       WHERE rm.property_id = $1`,
      [expectedDomain.propertyId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.hostname !== expectedDomain.hostname ||
      !row.property_domain_id ||
      row.verification_status !== "verified" ||
      row.canonical_when_verified !== true
    ) {
      findings.push({
        severity: "fail",
        code: "CATALOG_CUSTOM_DOMAIN_FIXTURE_MISMATCH",
        owner: "Hotel/property catalog",
        targetObject: "hotel_catalog.property_public_profile_read_model",
        message: `Expected property ${expectedDomain.propertyId} to project a verified canonical custom domain`,
        expected: `${expectedDomain.hostname} linked to verified canonical property_domains row`,
        actual: row ? JSON.stringify(row) : "row missing",
        suggestedAction:
          "Project custom domains only from verified property_domains rows marked canonical_when_verified.",
      });
    }
  }

  const forbiddenKeys = checks.forbiddenPublicProfileKeys ?? [];
  if (forbiddenKeys.length > 0) {
    const result = await client.query<{ property_id: string; profile: string }>(
      `SELECT property_id::text,
              concat_ws(
                ' ',
                location::text,
                descriptions::text,
                media::text,
                amenities::text,
                public_contacts::text,
                public_policy::text,
                source_freshness::text
              ) AS profile
       FROM hotel_catalog.property_public_profile_read_model`,
    );
    for (const row of result.rows) {
      const matchedKey = forbiddenKeys.find((key) => row.profile.includes(key));
      if (matchedKey) {
        findings.push({
          severity: "fail",
          code: "CATALOG_PUBLIC_PROFILE_PRIVATE_KEY_LEAK",
          owner: "Hotel/property catalog",
          targetObject: "hotel_catalog.property_public_profile_read_model",
          message: `Public profile for property ${row.property_id} contains forbidden key ${matchedKey}`,
          expected: "No provider/private keys in public read-model JSON",
          actual: matchedKey,
          suggestedAction:
            "Filter provider/private fields before projecting public catalog read models.",
        });
      }
    }
  }
}

export async function runParityChecks(config: ParityConfig): Promise<ParityReport> {
  const startedAt = new Date().toISOString();
  const runId = `${config.environment}-${config.fixtureCase}-${Date.now()}`;
  const findings: ParityFinding[] = [];

  const expectedPath = join(
    config.fixturesDir,
    "cases",
    config.fixtureCase,
    "expected-target.json",
  );
  const expected: ExpectedTarget = JSON.parse(await readFile(expectedPath, "utf8"));

  const client = new pg.Client({ connectionString: config.connectionString });
  await client.connect();

  try {
    await checkRowCounts(client, expected, findings);
    await checkIdStability(client, expected, findings);
    await checkUniqueness(client, expected, findings);
    await checkIdentityFixtures(client, expected, findings);
    await checkCatalogPublicProfileFixtures(client, expected, findings);
  } finally {
    await client.end();
  }

  const finishedAt = new Date().toISOString();
  const failures = findings.filter((f) => f.severity === "fail").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;

  return {
    runId,
    environment: config.environment,
    fixtureCase: config.fixtureCase,
    startedAt,
    finishedAt,
    status: failures > 0 ? "failed" : "passed",
    summary: { failures, warnings },
    findings,
  };
}
