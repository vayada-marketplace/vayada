import { createFixedChargePolicyStore } from "./fixedChargePolicyStore.js";
import { lockCurrentFixedCharges } from "./currentFixedCharges.js";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  createBookingPricingAuthorityStore,
  lockBookingPricingAuthority,
} from "./bookingPricingAuthority.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { createRoomLastMinuteStore } from "./roomLastMinuteStore.js";
import { lockReplacementLastMinute } from "./replacementLastMinute.js";
import { composeReplacementDiscounts } from "./replacementDiscountComposition.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("Booking pricing authority PostgreSQL owner", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const organizationId = randomUUID(),
      propertyId = randomUUID(),
      actorUserId = randomUUID(),
      membershipId = randomUUID(),
      roleKey = "authority_" + randomUUID();
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Authority test')", [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Authority test',$2)",
      [organizationId, organizationId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Authority test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,access_origin,property_access_mode)
      VALUES($1,$2,$3,$4,'agency','assigned')`,
      [membershipId, organizationId, actorUserId, roleKey],
    );
    for (const [product, type] of [
      ["pms", "pms_property"],
      ["hotel_catalog", "property"],
    ])
      await pool.query(
        `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship) VALUES($1,$2,$3,$4,'owner')`,
        [organizationId, product, type, propertyId],
      );
    await pool.query(
      "INSERT INTO identity.membership_property_assignments(membership_id,property_id) VALUES($1,$2)",
      [membershipId, propertyId],
    );
    await pool.query(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key) VALUES('hotel_group',$1,'pms.rooms_rates.manage')",
      [roleKey],
    );
    await pool.query(
      "INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key) VALUES('hotel_group',$1,'pms.rooms_rates.read')",
      [roleKey],
    );
    const context: RequestContext = {
      actor: {
        internalUserId: actorUserId,
        email: "authority@example.test",
        status: "active",
        providerIdentity: { provider: "workos", providerUserId: "test-user" },
      },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId,
        status: "active",
        roleKey,
        workosRoleSlugs: [],
        permissions: ["pms.rooms_rates.manage", "pms.rooms_rates.read"],
      },
      linkedResources: [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
      ],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      locale: "en",
      currency: "EUR",
      audit: { requestId: randomUUID(), source: "web", receivedAt: new Date().toISOString() },
    };
    const scope = { organizationId, propertyId, actorUserId },
      store = createBookingPricingAuthorityStore(pool);
    const command = { requestId: randomUUID(), expectedRevision: null, authority: "vayada" };
    const read = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockBookingPricingAuthority(client, propertyId);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { context, scope, store, command, read };
  }
  it("defaults to unconfigured and preserves revisioned choices and historical retry", async () => {
    const f = await fixture();
    expect(await f.read()).toEqual({
      authority: "unconfigured",
      revision: null,
      organizationId: null,
    });
    expect(await f.store.read(f.context, f.scope)).toEqual(await f.read());
    const first = await f.store.save(f.context, f.scope, f.command);
    expect(await f.read()).toEqual({
      authority: "vayada",
      revision: first.revision,
      organizationId: f.scope.organizationId,
    });
    expect(await f.store.read(f.context, f.scope)).toEqual(await f.read());
    const second = await f.store.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: first.revision,
      authority: "external",
    });
    expect(await f.read()).toEqual({
      authority: "external",
      revision: second.revision,
      organizationId: f.scope.organizationId,
    });
    expect(await f.store.save(f.context, f.scope, f.command)).toEqual({ ...first, replayed: true });
    expect((await f.read()).revision).toBe(second.revision);
    await expect(
      f.store.save(f.context, f.scope, { ...f.command, authority: "external" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await f.store.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: second.revision,
      authority: "unconfigured",
    });
    expect((await f.read()).authority).toBe("unconfigured");
    const rows = (
      await pool.query(
        "SELECT authority,actor_user_id,organization_id FROM booking.pricing_authority_revisions WHERE property_id=$1",
        [f.scope.propertyId],
      )
    ).rows;
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (r) =>
          r.actor_user_id === f.scope.actorUserId && r.organization_id === f.scope.organizationId,
      ),
    ).toBe(true);
  });
  it("serializes competing choices and rejects stale expected revisions", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.store.save(f.context, f.scope, f.command),
      f.store.save(f.context, f.scope, {
        ...f.command,
        requestId: randomUUID(),
        authority: "external",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale" },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM booking.pricing_authority_revisions WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("keeps a reader's authority stable until its transaction releases the property lock", async () => {
    const f = await fixture(),
      first = await f.store.save(f.context, f.scope, f.command);
    const command = {
      requestId: randomUUID(),
      expectedRevision: first.revision,
      authority: "external",
    };
    const limited = new pg.Pool({
      connectionString: url,
      max: 1,
      options: "-c lock_timeout=100ms",
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockBookingPricingAuthority(client, f.scope.propertyId)).toEqual({
        authority: "vayada",
        revision: first.revision,
        organizationId: f.scope.organizationId,
      });
      await expect(
        createBookingPricingAuthorityStore(limited).save(f.context, f.scope, command),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(await lockBookingPricingAuthority(client, f.scope.propertyId)).toEqual({
        authority: "vayada",
        revision: first.revision,
        organizationId: f.scope.organizationId,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await limited.end();
    }
    await f.store.save(f.context, f.scope, command);
    expect((await f.read()).authority).toBe("external");
  });
  it("checks live authorization even on an accepted retry and denies foreign scope", async () => {
    const f = await fixture();
    for (const context of [
      null,
      { ...f.context, membership: { ...f.context.membership, permissions: [] } },
      { ...f.context, entitlements: [] },
    ]) {
      await expect(f.store.save(context, f.scope, f.command)).rejects.toMatchObject({
        code: "denied",
      });
    }
    await expect(
      f.store.save(f.context, { ...f.scope, propertyId: randomUUID() }, f.command),
    ).rejects.toMatchObject({ code: "denied" });
    await f.store.save(f.context, f.scope, f.command);
    await pool.query("UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1", [
      f.context.membership.membershipId,
    ]);
    await expect(f.store.save(f.context, f.scope, f.command)).rejects.toMatchObject({
      code: "denied",
    });
  });
  it("rejects malformed commands before a write", async () => {
    const f = await fixture();
    for (const change of [
      { authority: "automatic" },
      { expectedRevision: "1" },
      { requestId: " " },
      { propertyId: f.scope.propertyId },
    ]) {
      await expect(
        f.store.save(f.context, f.scope, { ...f.command, ...change }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(await f.read()).toEqual({
      authority: "unconfigured",
      revision: null,
      organizationId: null,
    });
  });
  async function publicFixture() {
    const f = await fixture(),
      propertyId = f.scope.propertyId;
    await pool.query(
      "UPDATE hotel_catalog.properties SET lifecycle_status='active',profile_status='complete' WHERE id=$1",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1::uuid,$1::text,'canonical')",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Etc/UTC')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
      (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
      VALUES($1::uuid,$1::text,'Public authority test',$1::text,'en',ARRAY['en'],'complete')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
      (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,default_currency,
       supported_currencies,profile_status,freshness_status,public_setup_completeness,capabilities)
      VALUES($1::uuid,$1::text,$1::text,'https://example.test','https://example.test','Etc/UTC','EUR',
       ARRAY['EUR'],'public','fresh','{"status":"ready"}','{"paymentMethods":["pay_at_property"]}')`,
      [propertyId],
    );
    const readPublic = async (slug: unknown = propertyId) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockPublicPricingAuthority(client, slug);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { ...f, readPublic };
  }
  it("requires an explicit current local source and exact public canonical identity", async () => {
    const f = await publicFixture();
    expect(await f.readPublic()).toBeNull();
    const first = await f.store.save(f.context, f.scope, f.command);
    expect(await f.readPublic()).toEqual({
      propertyId: f.scope.propertyId,
      organizationId: f.scope.organizationId,
      authorityRevision: first.revision,
    });
    for (const slug of [null, {}, "", " ", "x".repeat(201), randomUUID()])
      expect(await f.readPublic(slug)).toBeNull();
    await pool.query(
      "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'marketplace_overlay')",
      [f.scope.propertyId, "alias-" + f.scope.propertyId],
    );
    expect(await f.readPublic("alias-" + f.scope.propertyId)).toBeNull();
    const second = await f.store.save(f.context, f.scope, {
      ...f.command,
      requestId: randomUUID(),
      expectedRevision: first.revision,
      authority: "external",
    });
    expect(await f.readPublic()).toBeNull();
    await f.store.save(f.context, f.scope, {
      ...f.command,
      requestId: randomUUID(),
      expectedRevision: second.revision,
      authority: "unconfigured",
    });
    expect(await f.readPublic()).toBeNull();
  });
  it("rejects hidden, stale, expired, incomplete and malformed public profiles", async () => {
    const f = await publicFixture();
    await f.store.save(f.context, f.scope, f.command);
    const client = await pool.connect();
    try {
      for (const change of [
        "UPDATE hotel_catalog.properties SET profile_status='private' WHERE id=$1",
        "UPDATE hotel_catalog.properties SET profile_status='disabled' WHERE id=$1",
        "UPDATE hotel_catalog.properties SET lifecycle_status='suspended' WHERE id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET profile_status='unpublished' WHERE property_id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET freshness_status='stale' WHERE property_id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET expires_at=clock_timestamp()-interval '1 second' WHERE property_id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET public_setup_completeness='{}' WHERE property_id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET capabilities='{\"paymentMethods\":{}}' WHERE property_id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET capabilities='{\"paymentMethods\":[]}' WHERE property_id=$1",
        "UPDATE distribution.public_hotel_bookability_profiles SET canonical_slug='old-slug' WHERE property_id=$1",
        "UPDATE hotel_catalog.property_slugs SET status='retired' WHERE property_id=$1",
      ]) {
        await client.query("BEGIN");
        try {
          await client.query(change, [f.scope.propertyId]);
          expect(await lockPublicPricingAuthority(client, f.scope.propertyId)).toBeNull();
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
    expect(await f.readPublic()).not.toBeNull();
  });
  it("rejects lost ownership, inactive organizations and unavailable current entitlements", async () => {
    const f = await publicFixture();
    await f.store.save(f.context, f.scope, f.command);
    const client = await pool.connect();
    try {
      for (const change of [
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1 AND product='pms'",
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1 AND product='hotel_catalog'",
        "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
        "DELETE FROM identity.product_entitlements WHERE organization_id=$1",
        "UPDATE identity.product_entitlements SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
        "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','account_access','suspended')",
      ]) {
        await client.query("BEGIN");
        try {
          await client.query(change, [f.scope.organizationId]);
          expect(await lockPublicPricingAuthority(client, f.scope.propertyId)).toBeNull();
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
  });
  it("holds public visibility, ownership and entitlement decisions through the caller transaction", async () => {
    const f = await publicFixture();
    await f.store.save(f.context, f.scope, f.command);
    const client = await pool.connect(),
      writer = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockPublicPricingAuthority(client, f.scope.propertyId)).not.toBeNull();
      await writer.query("SET lock_timeout='100ms'");
      for (const [sql, id] of [
        [
          "UPDATE distribution.public_hotel_bookability_profiles SET profile_status='unpublished' WHERE property_id=$1",
          f.scope.propertyId,
        ],
        [
          "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
          f.scope.organizationId,
        ],
        [
          "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','account_access','suspended')",
          f.scope.organizationId,
        ],
      ])
        await expect(writer.query(sql!, [id])).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      await writer.query("RESET lock_timeout");
      client.release();
      writer.release();
    }
  });
  it("evaluates profile expiry against the current clock, not transaction start", async () => {
    const f = await publicFixture();
    await f.store.save(f.context, f.scope, f.command);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE distribution.public_hotel_bookability_profiles SET expires_at=now()+interval '50 milliseconds' WHERE property_id=$1",
        [f.scope.propertyId],
      );
      await client.query("SELECT pg_sleep(0.06)");
      expect(await lockPublicPricingAuthority(client, f.scope.propertyId)).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("uses the locale-less public slug namespace even when another catalog locale shares its text", async () => {
    const f = await publicFixture(),
      other = await fixture();
    await f.store.save(f.context, f.scope, f.command);
    await pool.query(
      "INSERT INTO hotel_catalog.property_slugs(property_id,slug,locale,purpose) VALUES($1,$2,'de','canonical')",
      [other.scope.propertyId, f.scope.propertyId],
    );
    expect(await f.readPublic()).toMatchObject({ propertyId: f.scope.propertyId });
    await expect(
      pool.query(
        "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'canonical')",
        [other.scope.propertyId, f.scope.propertyId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query("UPDATE hotel_catalog.property_slugs SET locale='en' WHERE property_id=$1", [
      f.scope.propertyId,
    ]);
    expect(await f.readPublic()).toBeNull();
  });
  async function lastMinuteFixture() {
    const f = await fixture(),
      roomTypeId = randomUUID();
    await pool.query(
      "INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Last minute room')",
      [roomTypeId, f.scope.propertyId],
    );
    const store = createRoomLastMinuteStore(pool),
      command = {
        requestId: randomUUID(),
        roomTypeId,
        expectedRevision: null,
        policy: { enabled: true, tiers: [] },
      };
    return { ...f, roomTypeId, lastMinuteStore: store, lastMinuteCommand: command };
  }
  it("persists immutable room choices with compare-and-set and historical retry", async () => {
    const f = await lastMinuteFixture(),
      store = f.lastMinuteStore,
      command = f.lastMinuteCommand;
    const first = await store.save(f.context, f.scope, command);
    const second = await store.save(f.context, f.scope, {
      ...command,
      requestId: randomUUID(),
      expectedRevision: first.revision,
      policy: { enabled: false, tiers: [] },
    });
    expect(await store.save(f.context, f.scope, command)).toEqual({ ...first, replayed: true });
    expect(
      (
        await pool.query(
          "SELECT revision FROM booking.room_last_minute_heads WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].revision,
    ).toBe(second.revision);
    await expect(
      store.save(f.context, f.scope, { ...command, policy: { enabled: false, tiers: [] } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      store.save(f.context, f.scope, { ...command, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "stale" });
    await expect(
      pool.query("UPDATE booking.room_last_minute_revisions SET policy='{}' WHERE revision=$1", [
        first.revision,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    const receipt = (
      await pool.query(
        "SELECT organization_id,actor_user_id FROM booking.room_last_minute_revisions WHERE revision=$1",
        [first.revision],
      )
    ).rows[0];
    expect(receipt).toEqual({
      organization_id: f.scope.organizationId,
      actor_user_id: f.scope.actorUserId,
    });
  });
  it("denies foreign rooms, missing or revoked staff authority, and malformed tiers", async () => {
    const f = await lastMinuteFixture(),
      other = await lastMinuteFixture(),
      store = f.lastMinuteStore,
      command = f.lastMinuteCommand;
    await expect(store.save(null, f.scope, command)).rejects.toMatchObject({ code: "denied" });
    await expect(
      store.save(f.context, f.scope, { ...command, roomTypeId: other.roomTypeId }),
    ).rejects.toMatchObject({ code: "denied" });
    for (const policy of [
      {
        enabled: true,
        tiers: [
          { daysBeforeMin: 0, daysBeforeMax: 3, discountPercent: 10 },
          { daysBeforeMin: 3, daysBeforeMax: null, discountPercent: 5 },
        ],
      },
      { enabled: true, tiers: [{ daysBeforeMin: 0, daysBeforeMax: null, discountPercent: 0.001 }] },
      { enabled: true, tiers: null },
    ])
      await expect(store.save(f.context, f.scope, { ...command, policy })).rejects.toMatchObject({
        code: "invalid",
      });
    await store.save(f.context, f.scope, command);
    await pool.query("UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1", [
      f.context.membership.membershipId,
    ]);
    await expect(store.save(f.context, f.scope, command)).rejects.toMatchObject({ code: "denied" });
  });
  it("serializes competing room override changes", async () => {
    const f = await lastMinuteFixture();
    const results = await Promise.allSettled([
      f.lastMinuteStore.save(f.context, f.scope, f.lastMinuteCommand),
      f.lastMinuteStore.save(f.context, f.scope, {
        ...f.lastMinuteCommand,
        requestId: randomUUID(),
        policy: { enabled: false, tiers: [] },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale" },
    });
  });
  async function currentLastMinuteFixture() {
    const f = await lastMinuteFixture(),
      ids = [f.roomTypeId, randomUUID(), randomUUID()];
    for (const id of ids.slice(1))
      await pool.query(
        "INSERT INTO pms.room_types(id,property_id,name) VALUES($1::uuid,$2,$1::text)",
        [id, f.scope.propertyId],
      );
    const hotel = {
      enabled: true,
      stackWithPromo: true,
      tiers: [
        { daysBeforeMin: 0, daysBeforeMax: 3, discountPercent: 20 },
        { daysBeforeMin: 4, daysBeforeMax: null, discountPercent: 10 },
      ],
    };
    await pool.query(
      "INSERT INTO booking.booking_settings(property_id,last_minute_discount) VALUES($1,$2)",
      [f.scope.propertyId, hotel],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Pacific/Kiritimati')",
      [f.scope.propertyId],
    );
    const today = (
      await pool.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS date",
      )
    ).rows[0].date as string;
    const input = (days = 3) => ({
      propertyId: f.scope.propertyId,
      roomTypeIds: ids,
      checkIn: new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10),
    });
    const read = async (days = 3) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockReplacementLastMinute(client, input(days));
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { ...f, ids, hotel, today, input, readLastMinute: read };
  }
  it("resolves inherited, opted-out and overridden rooms under the hotel master switch", async () => {
    const f = await currentLastMinuteFixture();
    await f.lastMinuteStore.save(f.context, f.scope, {
      ...f.lastMinuteCommand,
      roomTypeId: f.ids[1],
      policy: { enabled: false, tiers: [] },
    });
    const saved = await f.lastMinuteStore.save(f.context, f.scope, {
      ...f.lastMinuteCommand,
      requestId: randomUUID(),
      roomTypeId: f.ids[2],
      policy: {
        enabled: true,
        tiers: [{ daysBeforeMin: 0, daysBeforeMax: null, discountPercent: 12.5 }],
      },
    });
    const first = await f.readLastMinute();
    expect(first?.rooms.map((r) => r.lastMinute?.basisPoints ?? null)).toEqual([2000, null, 1250]);
    expect(first).toMatchObject({
      bookingLocalDate: f.today,
      daysBeforeArrival: 3,
      stacking: true,
    });
    await f.lastMinuteStore.save(f.context, f.scope, {
      ...f.lastMinuteCommand,
      requestId: randomUUID(),
      roomTypeId: f.ids[2],
      expectedRevision: saved.revision,
    });
    const inherited = await f.readLastMinute();
    expect(inherited?.rooms.map((r) => r.lastMinute?.basisPoints ?? null)).toEqual([
      2000,
      null,
      2000,
    ]);
    expect(inherited?.sourceRevision).not.toBe(first?.sourceRevision);
    await pool.query(
      "UPDATE booking.booking_settings SET last_minute_discount=$2 WHERE property_id=$1",
      [f.scope.propertyId, { enabled: false, stackWithPromo: false, tiers: [] }],
    );
    expect((await f.readLastMinute())?.rooms.every((r) => r.lastMinute === null)).toBe(true);
  });
  it("uses inclusive lead-day tiers and feeds the saved stacking choice into discount arithmetic", async () => {
    const f = await currentLastMinuteFixture();
    expect((await f.readLastMinute(0))?.rooms[0].lastMinute?.basisPoints).toBe(2000);
    expect((await f.readLastMinute(4))?.rooms[0].lastMinute?.basisPoints).toBe(1000);
    expect((await f.readLastMinute(200))?.rooms[0].lastMinute?.basisPoints).toBe(1000);
    const price = async () => {
      const policy = (await f.readLastMinute())!;
      return composeReplacementDiscounts({
        rooms: [
          {
            selectionId: "one",
            roomMinor: "10000",
            lastMinute: policy.rooms[0].lastMinute,
            codeEligible: true,
          },
        ],
        eligibleAddonMinor: "0",
        code: { kind: "percentage", basisPoints: 1000 },
        stacking: policy.stacking,
      });
    };
    expect((await price())?.remainingRoomAndEligibleAddonMinor).toBe("7200");
    await pool.query(
      "UPDATE booking.booking_settings SET last_minute_discount=$2 WHERE property_id=$1",
      [f.scope.propertyId, { ...f.hotel, stackWithPromo: false }],
    );
    expect((await price())?.remainingRoomAndEligibleAddonMinor).toBe("8000");
  });
  it("rejects missing, malformed and unsupported hotel policy evidence", async () => {
    const f = await currentLastMinuteFixture();
    for (const value of [
      {},
      { ...f.hotel, tiers: [f.hotel.tiers[0], f.hotel.tiers[0]] },
      {
        ...f.hotel,
        promotions: [
          {
            type: "EARLY_BIRD",
            active: true,
            roomTypeIds: [],
            discountPercent: 10,
            threshold: 30,
            freeNights: 0,
            weekdays: [],
            tiers: [],
          },
        ],
      },
    ]) {
      await pool.query(
        "UPDATE booking.booking_settings SET last_minute_discount=$2 WHERE property_id=$1",
        [f.scope.propertyId, value],
      );
      expect(await f.readLastMinute()).toBeNull();
    }
    await pool.query("DELETE FROM booking.booking_settings WHERE property_id=$1", [
      f.scope.propertyId,
    ]);
    expect(await f.readLastMinute()).toBeNull();
  });
  it("holds hotel and room override state through the consuming transaction", async () => {
    const f = await currentLastMinuteFixture(),
      client = await pool.connect(),
      writer = new pg.Pool({ connectionString: url, max: 1, options: "-c lock_timeout=100ms" });
    try {
      await client.query("BEGIN");
      expect(await lockReplacementLastMinute(client, f.input())).not.toBeNull();
      await expect(
        createRoomLastMinuteStore(writer).save(f.context, f.scope, f.lastMinuteCommand),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        writer.query(
          "UPDATE booking.booking_settings SET last_minute_discount='{}' WHERE property_id=$1",
          [f.scope.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await writer.end();
    }
  });
  async function chargeFixture() {
    const f = await fixture(),
      store = createFixedChargePolicyStore(pool);
    const policy = {
      version: "booking.fixed-charges.v1",
      currency: "EUR",
      charges: [
        {
          id: "city",
          name: "City fee",
          unit: "person_night",
          amountMinor: "300",
          minimumAge: 18,
          included: false,
          collect: "property",
        },
      ],
    };
    const command = { requestId: randomUUID(), expectedRevision: null, policy };
    const stay = {
      propertyId: f.scope.propertyId,
      checkIn: "2026-10-01",
      checkOut: "2026-10-04",
      currency: "EUR",
      promoCode: null,
      addons: [],
      rooms: [
        {
          selectionId: "one",
          roomTypeId: randomUUID(),
          offerId: "flex",
          guests: { adults: 2, childAgesAtCheckIn: [5] },
        },
      ],
    };
    const read = async (value: unknown = stay) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        return await lockCurrentFixedCharges(c, value);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    return { ...f, store, policy, command, stay, read };
  }
  it("saves complete charge policies with immutable history, current amounts and reauthorized retries", async () => {
    const f = await chargeFixture();
    expect(await f.read()).toBeNull();
    const first = await f.store.save(f.context, f.scope, f.command),
      priced = await f.read();
    expect(priced).toMatchObject({ policyRevision: first.revision, additionalChargeMinor: "1800" });
    const empty = await f.store.save(f.context, f.scope, {
      ...f.command,
      requestId: randomUUID(),
      expectedRevision: first.revision,
      policy: { ...f.policy, charges: [] },
    });
    expect(await f.read()).toMatchObject({
      policyRevision: empty.revision,
      charges: [],
      additionalChargeMinor: "0",
    });
    expect((await f.read())?.sourceRevision).not.toBe(priced?.sourceRevision);
    expect(await f.store.save(f.context, f.scope, f.command)).toMatchObject({
      revision: first.revision,
      replayed: true,
    });
    expect((await f.read())?.policyRevision).toBe(empty.revision);
    expect(priced?.charges[0].amountMinor).toBe("1800");
    await expect(
      f.store.save(f.context, f.scope, { ...f.command, policy: { ...f.policy, charges: [] } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      f.store.save(f.context, f.scope, { ...f.command, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "stale" });
    const history = (
      await pool.query(
        "SELECT actor_user_id,organization_id FROM booking.fixed_charge_revisions WHERE revision=$1",
        [first.revision],
      )
    ).rows[0];
    expect(history).toEqual({
      actor_user_id: f.scope.actorUserId,
      organization_id: f.scope.organizationId,
    });
    for (const sql of [
      "UPDATE booking.fixed_charge_revisions SET policy='{}' WHERE revision=$1",
      "DELETE FROM booking.fixed_charge_revisions WHERE revision=$1",
    ])
      await expect(pool.query(sql, [first.revision])).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("TRUNCATE booking.fixed_charge_revisions CASCADE"),
    ).rejects.toMatchObject({ code: "55000" });
    await pool.query("UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1", [
      f.context.membership!.membershipId,
    ]);
    await expect(f.store.save(f.context, f.scope, f.command)).rejects.toMatchObject({
      code: "denied",
    });
  });
  it("denies missing/foreign auth and unsupported policy values; current reads reject currency mismatch", async () => {
    const f = await chargeFixture(),
      other = await chargeFixture();
    await expect(f.store.save(null, f.scope, f.command)).rejects.toMatchObject({ code: "denied" });
    await expect(f.store.save(other.context, f.scope, f.command)).rejects.toMatchObject({
      code: "denied",
    });
    await expect(
      f.store.save(f.context, f.scope, {
        ...f.command,
        policy: { ...f.policy, charges: [{ ...f.policy.charges[0], unit: "percentage" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await f.store.save(f.context, f.scope, f.command);
    expect(await f.read({ ...f.stay, currency: "USD" })).toBeNull();
    expect(await f.read({ ...f.stay, propertyId: other.scope.propertyId })).toBeNull();
    const original = await f.read();
    expect((await f.read({ ...f.stay, checkOut: "2026-10-05" }))?.basisEvidenceId).not.toBe(
      original?.basisEvidenceId,
    );
  });
  it("serializes competing charge writes and keeps the selected policy locked through consumption", async () => {
    const f = await chargeFixture();
    const results = await Promise.allSettled([
      f.store.save(f.context, f.scope, f.command),
      f.store.save(f.context, f.scope, { ...f.command, requestId: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const current = await f.read(),
      reader = await pool.connect();
    try {
      await reader.query("BEGIN");
      expect(await lockCurrentFixedCharges(reader, f.stay)).not.toBeNull();
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SET LOCAL lock_timeout='100ms'");
        await expect(
          writer.query("DELETE FROM booking.fixed_charge_heads WHERE property_id=$1", [
            f.scope.propertyId,
          ]),
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
    expect((await f.read())?.policyRevision).toBe(current?.policyRevision);
  });
});
