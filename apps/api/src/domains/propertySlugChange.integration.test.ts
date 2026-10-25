import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createPropertySlugChangeCommand,
  type PropertySlugChangeErrorCode,
} from "./propertySlugChange.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("operator booking address change in PostgreSQL (VAY-2295)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  afterAll(() => pool.end());
  const ready = {
    getBookingReadiness: vi.fn(async () => ({
      outcome: "evaluated",
      product: "booking",
      status: "ready",
    })),
  };
  const refresh = vi.fn(async () => ({ status: "succeeded", operationId: randomUUID() }));
  const command = createPropertySlugChangeCommand({
    pool,
    refresh: refresh as never,
    readiness: ready as never,
  });

  async function operator() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const [organizationId, actorUserId] = [randomUUID(), randomUUID()];
    await pool.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
      actorUserId,
      `operator-${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'platform','Vayada',$2,'active')",
      [organizationId, `platform-${organizationId}`],
    );
    await pool.query(
      "INSERT INTO identity.organization_memberships(organization_id,user_id,status,role_key,access_origin) VALUES($1,$2,'active','platform_admin','agency')",
      [organizationId, actorUserId],
    );
    await pool.query(
      "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'platform','platform','vayada','operator','active')",
      [organizationId],
    );
    return {
      actorUserId,
      organizationId,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      requestedAt: new Date().toISOString(),
    };
  }

  /** An active hotel at hotel-<n> whose former address former-<n> redirects to it. */
  async function hotel(options: { live?: boolean } = {}) {
    const propertyId = randomUUID();
    const n = propertyId.slice(0, 8);
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, lifecycle_status)
       VALUES ($1::uuid, $2, 'Slug Change Test', 'active')`,
      [propertyId, `slug-change-${n}`],
    );
    await pool.query(
      `WITH canonical AS (
         INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, $2, 'canonical', 'active') RETURNING id
       )
       INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status, redirects_to_id)
       SELECT $1::uuid, $3, 'redirect', 'redirected', id FROM canonical`,
      [propertyId, `hotel-${n}`, `former-${n}`],
    );
    let owner: { organizationId: string; userId: string } | null = null;
    if (options.live) {
      owner = { organizationId: randomUUID(), userId: randomUUID() };
      await pool.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
        owner.userId,
        `owner-${owner.userId}@example.test`,
      ]);
      await pool.query(
        "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','Slug Hotel',$2,'active')",
        [owner.organizationId, `hotel-${owner.organizationId}`],
      );
      await pool.query(
        // Owners keep access to every property (0104); the republish checks it (VAY-2335).
        "INSERT INTO identity.organization_memberships(organization_id,user_id,status,role_key,access_origin,property_access_mode) VALUES($1,$2,'active','owner','agency','all')",
        [owner.organizationId, owner.userId],
      );
      await pool.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'booking', 'booking_hotel', $2::uuid::text, 'owner', 'active')`,
        [owner.organizationId, propertyId],
      );
      await pool.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id)
         VALUES ($1::uuid, 'booking', 'booking-engine', 'active', 'booking', 'booking_hotel', $2::uuid::text)`,
        [owner.organizationId, propertyId],
      );
      const revisionId = randomUUID();
      await pool.query(
        `INSERT INTO distribution.public_booking_content_revisions (
           id, property_id, revision_number, readiness_contract_version,
           source_manifest, source_manifest_hash, readiness_hash,
           readiness_product, readiness_status, public_content, built_by_user_id
         ) VALUES (
           $1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1', $3::jsonb, $4, $5,
           'booking', 'ready', jsonb_build_object('profile', jsonb_build_object('hotel',
             jsonb_build_object('slug', $6::text))), $7::uuid
         )`,
        [
          revisionId,
          propertyId,
          JSON.stringify({
            contractVersion: "onboarding-source-manifest.v1",
            propertyId,
            sources: [{ owner: "hotel_catalog", entityId: propertyId, revision: "1" }],
          }),
          `sha256:${"1".repeat(64)}`,
          `sha256:${"2".repeat(64)}`,
          `hotel-${n}`,
          owner.userId,
        ],
      );
      await pool.query(
        `INSERT INTO distribution.active_public_booking_revision
           (property_id, content_revision_id, activated_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [propertyId, revisionId, owner.userId],
      );
    }
    return { propertyId, n, owner };
  }

  const addresses = async (propertyId: string) =>
    (
      await pool.query(
        `SELECT s.slug, s.purpose, s.status, target.slug AS "redirectsTo"
         FROM hotel_catalog.property_slugs s
         LEFT JOIN hotel_catalog.property_slugs target ON target.id = s.redirects_to_id
         WHERE s.property_id = $1::uuid ORDER BY s.slug`,
        [propertyId],
      )
    ).rows;
  const profileSlug = async (propertyId: string) =>
    (
      await pool.query(
        "SELECT canonical_slug FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
        [propertyId],
      )
    ).rows[0]?.canonical_slug;
  const audits = async (propertyId: string) =>
    (
      await pool.query(
        `SELECT actor_user_id::text AS actor, redacted_payload, private_payload
         FROM platform.product_audit_events
         WHERE property_id = $1::uuid AND action = 'platform.property.slug.change'
         ORDER BY occurred_at`,
        [propertyId],
      )
    ).rows;
  const change = async (
    audit: Awaited<ReturnType<typeof operator>>,
    propertyId: string,
    slug: string,
  ) => {
    const { planSha256 } = await command.preview({ propertyId, slug, audit });
    return command.apply({
      propertyId,
      slug,
      audit,
      reason: "VAY-2295 test",
      expectedPlanSha256: planSha256,
    });
  };

  it("moves the address, keeps every former one redirecting, and rolls back", async () => {
    const audit = await operator();
    const { propertyId, n } = await hotel();
    const preview = await command.preview({ propertyId, slug: `lodge-${n}`, audit });
    expect(preview.plan).toEqual({
      contractVersion: "platform-admin-property-slug-change.v1",
      propertyId,
      fromSlug: `hotel-${n}`,
      toSlug: `lodge-${n}`,
      change: "new_address",
      livePage: null,
    });
    expect(preview.planSha256).toMatch(/^[0-9a-f]{64}$/);
    const before = await addresses(propertyId);

    const result = await command.apply({
      propertyId,
      slug: `lodge-${n}`,
      audit,
      reason: "VAY-2295 test",
      expectedPlanSha256: preview.planSha256,
    });
    expect(result).toMatchObject({
      planSha256: preview.planSha256,
      publication: { status: "not_live" },
    });
    expect(before).not.toEqual(await addresses(propertyId));
    expect(await addresses(propertyId)).toEqual([
      { slug: `former-${n}`, purpose: "redirect", status: "redirected", redirectsTo: `lodge-${n}` },
      { slug: `hotel-${n}`, purpose: "redirect", status: "redirected", redirectsTo: `lodge-${n}` },
      { slug: `lodge-${n}`, purpose: "canonical", status: "active", redirectsTo: null },
    ]);
    expect(await profileSlug(propertyId)).toBe(`lodge-${n}`);
    expect(await audits(propertyId)).toEqual([
      {
        actor: audit.actorUserId,
        redacted_payload: {
          fromSlug: `hotel-${n}`,
          toSlug: `lodge-${n}`,
          planSha256: preview.planSha256,
          republishAsUserId: null,
        },
        private_payload: { reason: "VAY-2295 test" },
      },
    ]);

    // Running it again changes nothing.
    expect((await change(audit, propertyId, `lodge-${n}`)).plan.change).toBe("already_applied");
    expect(await audits(propertyId)).toHaveLength(1);

    // Rollback: the former address becomes the current one again.
    const back = await change(audit, propertyId, `hotel-${n}`);
    expect(back.plan).toMatchObject({ fromSlug: `lodge-${n}`, change: "former_address" });
    expect(await addresses(propertyId)).toEqual([
      { slug: `former-${n}`, purpose: "redirect", status: "redirected", redirectsTo: `hotel-${n}` },
      { slug: `hotel-${n}`, purpose: "canonical", status: "active", redirectsTo: null },
      { slug: `lodge-${n}`, purpose: "redirect", status: "redirected", redirectsTo: `hotel-${n}` },
    ]);
    expect(await profileSlug(propertyId)).toBe(`hotel-${n}`);

    // The same moves again are new changes, each with its own audit row.
    expect((await change(audit, propertyId, `lodge-${n}`)).plan.change).toBe("former_address");
    expect((await change(audit, propertyId, `hotel-${n}`)).plan.change).toBe("former_address");
    expect(await addresses(propertyId)).toEqual([
      { slug: `former-${n}`, purpose: "redirect", status: "redirected", redirectsTo: `hotel-${n}` },
      { slug: `hotel-${n}`, purpose: "canonical", status: "active", redirectsTo: null },
      { slug: `lodge-${n}`, purpose: "redirect", status: "redirected", redirectsTo: `hotel-${n}` },
    ]);
    expect(await audits(propertyId)).toHaveLength(4);
  });

  it("refuses without writing anything", async () => {
    const audit = await operator();
    const { propertyId, n } = await hotel();
    const other = await hotel();
    const before = await addresses(propertyId);
    const refuses = async (
      code: PropertySlugChangeErrorCode,
      slug: string,
      input: Partial<Parameters<typeof command.apply>[0]> = {},
    ) => {
      const request = { propertyId, slug, audit, reason: "VAY-2295 test", ...input };
      await expect(
        command.apply({ ...request, expectedPlanSha256: "0".repeat(64) }),
      ).rejects.toMatchObject({ code });
      expect(await addresses(propertyId)).toEqual(before);
    };
    for (const slug of [
      "Lodge",
      "-lodge",
      "lodge--x",
      "",
      "a".repeat(64),
      "lodge.example",
      "www",
      "booking",
    ])
      await refuses("invalid_slug", slug);
    await refuses("slug_taken", `hotel-${other.n}`);
    await refuses("slug_taken", `former-${other.n}`);
    await refuses("plan_changed", `lodge-${n}`);
    await refuses("invalid_platform_scope", `lodge-${n}`, {
      audit: { ...audit, actorUserId: other.propertyId },
    });
    await refuses("property_not_found", `lodge-${n}`, { propertyId: randomUUID() });

    await pool.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
         (property_id, public_id, display_name, canonical_slug, default_locale,
          supported_locales, profile_status)
       VALUES ($1::uuid, $2, 'Slug Change Test', $2, 'en', ARRAY['en'], 'complete')`,
      [propertyId, `hotel-${n}`],
    );
    await pool.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
         (property_id, public_id, canonical_slug, canonical_url, booking_base_url, timezone,
          default_currency, supported_currencies, profile_status, freshness_status,
          public_setup_completeness, capabilities)
       VALUES ($1::uuid, $2, $2, 'https://example.test', 'https://example.test', 'Etc/UTC',
               'EUR', ARRAY['EUR'], 'public', 'fresh', '{"status":"ready"}',
               '{"paymentMethods":["pay_at_property"]}')`,
      [propertyId, `hotel-${n}`],
    );
    await refuses("legacy_page_only", `lodge-${n}`);
    await pool.query(
      "UPDATE hotel_catalog.properties SET lifecycle_status = 'suspended' WHERE id = $1::uuid",
      [propertyId],
    );
    await refuses("property_unavailable", `lodge-${n}`);
    expect(await audits(propertyId)).toEqual([]);
  });

  it("republishes a live page as the user who made it live", async () => {
    const audit = await operator();
    const { propertyId, n, owner } = await hotel({ live: true });
    refresh.mockClear();
    const preview = await command.preview({ propertyId, slug: `lodge-${n}`, audit });
    expect(preview.plan.livePage).toEqual({
      pageSlug: `hotel-${n}`,
      organizationId: owner!.organizationId,
      republishAsUserId: owner!.userId,
    });
    const result = await command.apply({
      propertyId,
      slug: `lodge-${n}`,
      audit,
      reason: "VAY-2295 test",
      expectedPlanSha256: preview.planSha256,
    });
    expect(result.publication).toMatchObject({ status: "succeeded" });
    expect(refresh).toHaveBeenCalledWith({
      organizationId: owner!.organizationId,
      propertyId,
      actorUserId: owner!.userId,
      idempotencyKey: `platform-property-slug-change:${audit.requestId}`,
      audit: {
        requestId: audit.requestId,
        correlationId: audit.correlationId,
        source: "platform_admin.property_slug_change",
      },
      onlyIfLive: true,
    });
    expect((await audits(propertyId))[0].redacted_payload.republishAsUserId).toBe(owner!.userId);

    // The stub left the page on its former address: a rerun retries only the republish, and a
    // failed republish is reported after the committed change.
    refresh.mockRejectedValueOnce(new Error("Booking publication readiness is incomplete."));
    const rerun = await change(audit, propertyId, `lodge-${n}`);
    expect(rerun).toMatchObject({
      plan: { change: "already_applied" },
      publication: { status: "failed", code: "page_not_ready" },
    });
    expect(await audits(propertyId)).toHaveLength(1);

    // A page that can't be rebuilt, or a user who lost access, stops the change before it starts.
    const before = await addresses(propertyId);
    const withoutRuntime = createPropertySlugChangeCommand({ pool });
    await expect(
      withoutRuntime.preview({ propertyId, slug: `inn-${n}`, audit }),
    ).rejects.toMatchObject({ code: "republish_unavailable" });
    ready.getBookingReadiness.mockResolvedValueOnce({
      outcome: "evaluated",
      product: "booking",
      status: "blocked",
    });
    await expect(command.preview({ propertyId, slug: `inn-${n}`, audit })).rejects.toMatchObject({
      code: "page_not_ready",
    });
    await pool.query(
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE user_id = $1::uuid",
      [owner!.userId],
    );
    await expect(command.preview({ propertyId, slug: `inn-${n}`, audit })).rejects.toMatchObject({
      code: "republish_user_unavailable",
    });
    expect(await addresses(propertyId)).toEqual(before);
  });
});
