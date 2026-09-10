import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPgPreparedImportRepository } from "./domains/preparedHotelImportRepository.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("prepared import durable binding", () => {
  const org = randomUUID(),
    actor = randomUUID(),
    invite = randomUUID(),
    property = randomUUID(),
    other = randomUUID();
  const db = new pg.Client({ connectionString: url });
  const repository = createPgPreparedImportRepository(url ?? "postgresql://disabled");
  const scope = { organizationId: org, actorUserId: actor };
  beforeAll(async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || !target.pathname.endsWith("_test"))
      throw new Error("Requires isolated local test database");
    await db.connect();
    await db.query(
      "INSERT INTO identity.users(id,email,status) VALUES($1,'import@example.test','active')",
      [actor],
    );
    await db.query(
      "INSERT INTO identity.organizations(id,kind,name,slug,status,workos_external_id) VALUES($1::uuid,'hotel_group','Import Group',$1::text,'active',$2)",
      [org, `vayada-signup:marketplace-web:hotel:invite:${invite}`],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Hotel A'),($2::uuid,$2::text,'Hotel B')",
      [property, other],
    );
    const payload = {
      contractVersion: "hotel-account-invite.v1",
      redemption: { organizationId: org },
      preparedData: {
        contractVersion: "prepared-hotel-import.v1",
        property: { displayName: "Prepared" },
        rooms: [],
      },
    };
    await db.query(
      "INSERT INTO marketplace.invite_codes(id,code,invite_type,status,payload,redeemed_by_user_id) VALUES($1::uuid,$1::text,'hotel','redeemed',$2,$3)",
      [invite, payload, actor],
    );
  });
  afterAll(async () => {
    await db.query("DELETE FROM hotel_catalog.prepared_import_applications WHERE invite_id=$1", [
      invite,
    ]);
    await db.query("DELETE FROM marketplace.invite_codes WHERE id=$1", [invite]);
    await db.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
      [property, other],
    ]);
    await db.query("DELETE FROM identity.organizations WHERE id=$1", [org]);
    await db.query("DELETE FROM identity.users WHERE id=$1", [actor]);
    await repository.close();
    await db.end();
  });
  it("exposes only the accepting actor and invite-derived organization", async () => {
    expect((await repository.find(scope))?.sourceId).toBe(invite);
    expect(await repository.find({ ...scope, actorUserId: randomUUID() })).toBeNull();
    expect(await repository.find({ ...scope, organizationId: randomUUID() })).toBeNull();
  });
  it.each(["pending", "revoked", "expired"])("does not expose %s invitations", async (status) => {
    await db.query("UPDATE marketplace.invite_codes SET status=$2 WHERE id=$1", [invite, status]);
    try {
      expect(await repository.find(scope)).toBeNull();
    } finally {
      await db.query("UPDATE marketplace.invite_codes SET status='redeemed' WHERE id=$1", [invite]);
    }
  });
  it("persists target binding through failure before result marking", async () => {
    await expect(
      repository.apply({ ...scope, sourceId: invite, propertyId: property }, async () => {
        throw new Error("lost response");
      }),
    ).rejects.toThrow("lost response");
    expect((await repository.find(scope))?.propertyId).toBe(property);
    await expect(
      repository.apply({ ...scope, sourceId: invite, propertyId: other }, async () => []),
    ).rejects.toThrow("import_property_conflict");
  });
  it("serializes concurrent retries and exposes saved markers to the next call", async () => {
    let writes = 0;
    const execute = async (source: Awaited<ReturnType<typeof repository.find>>) => {
      if (!source!.results["property:displayName"]) writes++;
      return [{ itemId: "property:displayName", status: "applied" as const, resourceId: property }];
    };
    await Promise.all([
      repository.apply({ ...scope, sourceId: invite, propertyId: property }, execute),
      repository.apply({ ...scope, sourceId: invite, propertyId: property }, execute),
    ]);
    expect(writes).toBe(1);
  });
});
