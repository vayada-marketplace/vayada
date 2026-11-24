import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTargetPlatformAdminDashboardRepository } from "./routes/platform/admin/dashboard/bookingCompatible.js";

/**
 * VAY-2602: Vayada Admin's hotel list (and the KPI page, which reads it) leaves out hotels whose
 * accounts are all archived (closed sign-ups and release smoke runs), unless the hotel still sells.
 * Real PostgreSQL with the migrated schema.
 */
const url = process.env["TEST_DATABASE_URL"];

type Holder = {
  account: string;
  product?: "hotel_catalog" | "pms";
  relationship?: "owner" | "operator" | "front_desk";
  link?: "active" | "archived";
};

describe.skipIf(!url)("Vayada Admin hotel list and archived accounts (VAY-2602)", () => {
  const admin = new pg.Client({ connectionString: url });
  const accounts: string[] = [];
  const properties: string[] = [];
  let staff = "";

  async function account(
    status: "active" | "suspended" | "archived",
    kind: "hotel_group" | "platform" = "hotel_group",
  ): Promise<string> {
    const id = randomUUID();
    accounts.push(id);
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, $2, 'VAY-2602 ' || $3, $1::text, $3)`,
      [id, kind, status],
    );
    return id;
  }

  async function hotel(...holders: Holder[]): Promise<string> {
    const id = randomUUID();
    properties.push(id);
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay2602-' || $1::text, 'VAY-2602 hotel')`,
      [id],
    );
    for (const holder of holders) {
      const product = holder.product ?? "hotel_catalog";
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        [
          holder.account,
          product,
          product === "pms" ? "pms_property" : "property",
          id,
          holder.relationship ?? "owner",
          holder.link ?? "active",
        ],
      );
    }
    return id;
  }

  /** A published booking page; the content revision itself doesn't matter here. */
  async function publish(property: string) {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      `INSERT INTO distribution.active_public_booking_revision
         (property_id, content_revision_id, activated_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [property, randomUUID(), staff],
    );
    await admin.query("COMMIT");
  }

  async function channel(property: string, status: "connected" | "disconnected") {
    await admin.query(
      `INSERT INTO pms.channel_connections (property_id, provider, connection_status)
       VALUES ($1::uuid, 'channex', $2)`,
      [property, status],
    );
  }

  beforeAll(async () => {
    await admin.connect();
    staff = randomUUID();
    await admin.query(
      "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2602 staff', 'active')",
      [staff, `vay2602-${staff}@example.test`],
    );
  });

  afterAll(async () => {
    if (properties.length) {
      await admin.query(
        "DELETE FROM distribution.active_public_booking_revision WHERE property_id = ANY($1::uuid[])",
        [properties],
      );
      await admin.query("DELETE FROM pms.channel_connections WHERE property_id = ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE resource_id = ANY($1::text[])",
        [properties],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        properties,
      ]);
    }
    if (accounts.length)
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        accounts,
      ]);
    if (staff) await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [staff]);
    await admin.end();
  });

  it("leaves out hotels whose accounts are all archived, unless they still sell", async () => {
    const open = await account("active");
    const paused = await account("suspended");
    const closed = await account("archived");
    const closedToo = await account("archived");
    const platform = await account("active", "platform");

    const shown = {
      open: await hotel({ account: open }),
      openThroughPms: await hotel({ account: closed }, { account: open, product: "pms" }),
      openOperator: await hotel({ account: closed }, { account: open, relationship: "operator" }),
      paused: await hotel({ account: paused }),
      unowned: await hotel(),
      oldLinkOnly: await hotel({ account: closed, link: "archived" }),
      published: await hotel({ account: closed }),
      onChannex: await hotel({ account: closed }),
    };
    await publish(shown.published);
    await channel(shown.onChannex, "connected");
    const hidden = {
      closed: await hotel({ account: closed }),
      closedPms: await hotel({ account: closed, product: "pms" }),
      closedTwice: await hotel({ account: closed }, { account: closedToo, product: "pms" }),
      openLinkEnded: await hotel({ account: closed }, { account: open, link: "archived" }),
      openFrontDeskOnly: await hotel(
        { account: closed },
        { account: open, relationship: "front_desk" },
      ),
      platformToo: await hotel({ account: closed }, { account: platform }),
      channelOff: await hotel({ account: closed }),
    };
    await channel(hidden.channelOff, "disconnected");

    const dashboard = createTargetPlatformAdminDashboardRepository({
      connectionString: url!,
      pool: {
        query: (text: string, values?: readonly unknown[]) =>
          admin.query(text, values as unknown[]),
        end: async () => undefined,
      } as never,
    });
    const listed = async (excludeTestData: boolean) => {
      const ids = new Set(
        (await dashboard.listGrowthProperties({ excludeTestData })).map(({ id }) => id),
      );
      return Object.fromEntries(
        Object.entries({ ...shown, ...hidden }).map(([name, id]) => [name, ids.has(id)]),
      );
    };
    const expected = {
      ...Object.fromEntries(Object.keys(shown).map((name) => [name, true])),
      ...Object.fromEntries(Object.keys(hidden).map((name) => [name, false])),
    };

    // The hotel list asks for everything, test data included; the KPI page leaves test data out.
    expect(await listed(false)).toEqual(expected);
    expect(await listed(true)).toEqual(expected);
  });
});
