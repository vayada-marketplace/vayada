import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockCurrentPmsAcceptedPricingOwner } from "./pmsAcceptedPricingReservationRepository.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("accepted pricing PMS ownership locking", () => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  afterAll(() => pool.end());

  it("waits for an earlier ownership revocation and then rejects it", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Adoption owner',($1::uuid)::text)",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Adoption owner')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO identity.organization_resource_links
       (organization_id,product,resource_type,resource_id,relationship)
       VALUES($1,'pms','pms_property',$2,'owner')`,
      [organizationId, propertyId],
    );
    await pool.query(
      `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key)
       VALUES($1,'pms','property-management')`,
      [organizationId],
    );
    const revoker = await pool.connect();
    const adopter = await pool.connect();
    let revokerOpen = false;
    try {
      await revoker.query("BEGIN");
      revokerOpen = true;
      await revoker.query(
        `UPDATE identity.organization_resource_links SET status='suspended'
         WHERE organization_id=$1 AND product='pms' AND resource_id=$2`,
        [organizationId, propertyId],
      );
      await adopter.query("BEGIN");
      const authorization = lockCurrentPmsAcceptedPricingOwner(adopter, {
        organizationId,
        propertyId,
      });
      expect(
        await Promise.race([
          authorization.then((value) => ({ completed: true, value })),
          new Promise<{ completed: false }>((resolve) =>
            setTimeout(() => resolve({ completed: false }), 100),
          ),
        ]),
      ).toEqual({ completed: false });
      await revoker.query("COMMIT");
      revokerOpen = false;
      await expect(authorization).resolves.toBe(false);
    } finally {
      if (revokerOpen) await revoker.query("ROLLBACK");
      await adopter.query("ROLLBACK");
      revoker.release();
      adopter.release();
      await pool.query("DELETE FROM identity.product_entitlements WHERE organization_id=$1", [
        organizationId,
      ]);
      await pool.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [organizationId],
      );
      await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await pool.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
    }
  });
});
