import { readFile } from "node:fs/promises";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { beforeEach } from "vitest";
import { assentFixture, disclosureHash } from "./affiliateAssentTestFixture.js";
import { id } from "./affiliatePublicationTestFixture.js";

export function assentCommandFixture() {
  const fixture = assentFixture();
  beforeEach(async () => {
    const pool = fixture.pool();
    await pool.query(`DROP SCHEMA IF EXISTS platform,hotel_catalog CASCADE;
      CREATE SCHEMA platform; CREATE SCHEMA hotel_catalog;
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY,profile_status TEXT DEFAULT 'complete');
      INSERT INTO hotel_catalog.properties VALUES ('${id(3)}'),('${id(6)}');
      ALTER TABLE marketplace.marketplace_offers ADD COLUMN offer_status TEXT DEFAULT 'verified';
      CREATE TABLE identity.organization_resource_links(id UUID PRIMARY KEY,organization_id UUID,
        product TEXT,resource_type TEXT,resource_id TEXT,relationship TEXT,status TEXT);
      INSERT INTO identity.organization_resource_links VALUES
        ('${id(90)}','${id(4)}','marketplace','hotel_profile','${id(3)}','owner','active'),
        ('${id(91)}','${id(80)}','marketplace','creator_profile','${id(82)}','owner','active'),
        ('${id(92)}','${id(4)}','marketplace','marketplace_offer','${id(2)}','operator','active');`);
    const platform = await readFile(
      new URL(
        "../../../../packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE FUNCTION platform.tenant_scope_key("),
        platform.indexOf("CREATE TABLE platform.domain_events ("),
      ),
    );
    await pool.query(
      platform.slice(
        platform.indexOf("CREATE TABLE platform.idempotency_keys ("),
        platform.indexOf("CREATE TABLE platform.dead_letter_events ("),
      ),
    );
  });
  return fixture;
}
export async function installAffiliateAgreementLifecycleFixture(pool: pg.Pool) {
  for (const migration of [
    "0214_marketplace_affiliate_agreement_activation.sql",
    "0326_marketplace_affiliate_agreement_lifecycle.sql",
  ])
    await pool.query(
      await readFile(
        new URL(`../../../../packages/backend-migration/migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
}
export function assentInput(hotel = true) {
  const context: RequestContext = {
    actor: {
      internalUserId: id(hotel ? 1 : 81),
      status: "active",
      email: "synthetic@example.test",
      providerIdentity: { provider: "workos", providerUserId: "test" },
    },
    selectedOrganization: {
      organizationId: id(hotel ? 4 : 80),
      kind: hotel ? "hotel_group" : "creator_workspace",
      status: "active",
    },
    membership: {
      membershipId: id(hotel ? 8 : 88),
      status: "active",
      roleKey: "owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.collaboration.write"],
      ...(hotel
        ? {
            propertyAccess: {
              mode: "assigned" as const,
              roleKey: "owner",
              accessOrigin: "agency" as const,
              assignedPropertyIds: [id(3)],
            },
          }
        : {}),
    },
    linkedResources: hotel
      ? [
          {
            product: "marketplace",
            resourceType: "hotel_profile",
            resourceId: id(3),
            relationship: "owner",
            status: "active",
          },
          {
            product: "marketplace",
            resourceType: "marketplace_offer",
            resourceId: id(2),
            relationship: "operator",
            status: "active",
          },
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: id(3),
            relationship: "owner",
            status: "active",
          },
        ]
      : [
          {
            product: "marketplace",
            resourceType: "creator_profile",
            resourceId: id(82),
            relationship: "owner",
            status: "active",
          },
        ],
    entitlements: hotel
      ? [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }]
      : [],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "assent-test", source: "api", receivedAt: new Date().toISOString() },
  };
  return {
    context,
    propertyId: id(3),
    programId: id(50),
    creatorProfileId: id(82),
    termsId: id(51),
    attemptId: id(100),
    expectedRevision: 0,
    idempotencyKey: hotel ? "hotel" : "creator",
    decision: hotel ? ("hotel_approval" as const) : ("creator_acceptance" as const),
    disclosureHash,
  };
}
