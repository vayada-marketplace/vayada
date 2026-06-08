import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

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

export async function checkPropertyCatalogPublicProfilesParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkCatalogPublicProfileFixtures(client, expected, findings);
}
