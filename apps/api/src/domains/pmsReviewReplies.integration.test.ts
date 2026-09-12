import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import { createPgReviewReplyCommands } from "./pmsReviewReplies.js";
import type { ReviewReplyProvider } from "../integrations/channexReviewReplies.js";

const url = process.env.TEST_DATABASE_URL;
const property = "10000000-0000-4000-8000-000000000001";
const actor = "10000000-0000-4000-8000-000000000002";
const context = {
  actor: { internalUserId: actor },
  audit: { requestId: "test" },
} as RequestContext;
describe.skipIf(!url)("review reply PostgreSQL receipts", () => {
  let db: pg.Client;
  let commands: ReturnType<typeof createPgReviewReplyCommands>;
  let provider: ReviewReplyProvider;
  beforeEach(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(`DROP SCHEMA IF EXISTS pms, identity, hotel_catalog, platform CASCADE;
      CREATE SCHEMA pms; CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog; CREATE SCHEMA platform;
      CREATE TABLE identity.users (id uuid PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties (id uuid PRIMARY KEY);
      CREATE TABLE pms.channel_connections (property_id uuid, provider text, connection_status text, external_property_id text);
      CREATE TABLE platform.product_audit_events (audit_key text, product text, action text, occurred_at timestamptz,
        tenant_scope text, property_id uuid, actor_type text, actor_user_id uuid, target_resource_product text,
        target_resource_type text, target_resource_id text, correlation_id text, redacted_payload jsonb);
      INSERT INTO identity.users VALUES ('${actor}'); INSERT INTO hotel_catalog.properties VALUES ('${property}');`);
    for (const name of ["0040_pms_channel_reviews.sql", "0183_pms_review_reply_submissions.sql"])
      await db.query(
        await readFile(
          new URL(`../../../../packages/backend-migration/migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    await db.query(
      `INSERT INTO pms.channel_connections VALUES ($1, 'channex', 'connected', 'external');
      `,
      [property],
    );
    await db.query(
      `INSERT INTO pms.channel_reviews (property_id, provider, provider_review_id, body) VALUES ($1, 'channex', 'review', 'Great')`,
      [property],
    );
    provider = {
      check: vi.fn(async () => ({ state: "ready" as const })),
      send: vi.fn(async () => ({ state: "accepted" as const, replyBody: "Thanks" })),
    };
    commands = createPgReviewReplyCommands({ connectionString: url!, provider });
  });
  afterEach(async () => {
    await commands?.close();
    await db?.end();
  });
  it("serializes simultaneous sends and persists receipt, text and actor audit", async () => {
    await Promise.all([
      commands.submit(context, property, "review", "Thanks"),
      commands.submit(context, property, "review", "Thanks"),
    ]);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(await commands.check(context, property, "review")).toMatchObject({
      state: "accepted",
      replyBody: "Thanks",
    });
    const { rows } = await db.query(
      "SELECT actor_user_id, redacted_payload FROM platform.product_audit_events",
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.actor_user_id === actor)).toBe(true);
    expect(rows.map((row) => row.redacted_payload)).toEqual(
      expect.arrayContaining([{ outcome: "submitting" }, { outcome: "accepted" }]),
    );
  });
  it.each(["ready", "unavailable"] as const)(
    "preserves uncertainty after unexpected send state %s",
    async (state) => {
      vi.mocked(provider.send).mockResolvedValue({ state });
      expect(await commands.submit(context, property, "review", "Thanks")).toMatchObject({
        state: "uncertain",
        reason: "confirmation_pending",
      });
      expect((await db.query("SELECT state FROM pms.review_reply_submissions")).rows[0].state).toBe(
        "uncertain",
      );
      vi.mocked(provider.check).mockResolvedValue({ state: "failed", reason: "provider_rejected" });
      expect(await commands.check(context, property, "review")).toMatchObject({
        state: "uncertain",
      });
      await commands.submit(context, property, "review", "Thanks");
      expect(provider.send).toHaveBeenCalledTimes(1);
    },
  );
  it("never resends uncertain outcomes; read-back can confirm them", async () => {
    vi.mocked(provider.send).mockResolvedValue({ state: "uncertain" });
    expect(await commands.submit(context, property, "review", "Thanks")).toMatchObject({
      state: "uncertain",
    });
    await commands.submit(context, property, "review", "Different text");
    expect(provider.send).toHaveBeenCalledTimes(1);
    vi.mocked(provider.check).mockResolvedValue({ state: "accepted", replyBody: "Thanks" });
    expect(await commands.check(context, property, "review")).toMatchObject({ state: "accepted" });
    expect((await db.query("SELECT state FROM pms.review_reply_submissions")).rows[0].state).toBe(
      "accepted",
    );
  });
  it("retains failed input and allows an explicit retry after fresh eligibility check", async () => {
    vi.mocked(provider.send).mockResolvedValueOnce({
      state: "failed",
      reason: "provider_rejected",
    });
    await commands.submit(context, property, "review", "Original text");
    expect(await commands.check(context, property, "review")).toMatchObject({
      state: "ready",
      draft: "Original text",
    });
    await commands.submit(context, property, "review", "Thanks");
    expect(provider.send).toHaveBeenCalledTimes(2);
  });
  it("blocks submission without an enabled provider", async () => {
    await commands.close();
    commands = createPgReviewReplyCommands({ connectionString: url! });
    expect(await commands.submit(context, property, "review", "Thanks")).toMatchObject({
      state: "unavailable",
    });
    expect((await db.query("SELECT * FROM pms.review_reply_submissions")).rows).toHaveLength(0);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("does not contact provider for a review outside the property", async () => {
    expect(await commands.submit(context, actor, "review", "Thanks")).toMatchObject({
      state: "unavailable",
    });
    expect(provider.check).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
});
