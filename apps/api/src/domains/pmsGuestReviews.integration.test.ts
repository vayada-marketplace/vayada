import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import { createPgGuestReviewCommands } from "./pmsGuestReviews.js";
import type { GuestReviewProvider } from "../integrations/channexGuestReviews.js";

const draft = {
  respectHouseRules: 5,
  communication: 4,
  cleanliness: 3,
  publicReview: "Good guest",
  privateReview: "Private",
  recommended: true,
};
const opportunity = {
  reviewId: "review",
  guestName: "Ada Guest",
  reservationCode: "HM123",
  state: "ready" as const,
};
const url = process.env.TEST_DATABASE_URL;
const property = "10000000-0000-4000-8000-000000000001";
const actor = "10000000-0000-4000-8000-000000000002";
const context = {
  actor: { internalUserId: actor },
  audit: { requestId: "test" },
} as RequestContext;
describe.skipIf(!url)("guest review PostgreSQL receipts", () => {
  let db: pg.Client;
  let commands: ReturnType<typeof createPgGuestReviewCommands>;
  let provider: GuestReviewProvider;
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
    for (const name of ["0184_pms_guest_review_submissions.sql"])
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
    provider = {
      check: vi.fn(async () => ({ ...opportunity, state: "ready" as const })),
      list: vi.fn(async () => ({ items: [opportunity], more: false })),
      send: vi.fn(async () => ({ state: "accepted" as const })),
    };
    commands = createPgGuestReviewCommands({ connectionString: url!, provider });
  });
  afterEach(async () => {
    await commands?.close();
    await db?.end();
  });
  it("serializes simultaneous sends and persists receipt, text and actor audit", async () => {
    await Promise.all([
      commands.submit(context, property, "review", draft),
      commands.submit(context, property, "review", draft),
    ]);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(await commands.check(context, property, "review")).toMatchObject({
      state: "accepted",
      draft,
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
      expect(await commands.submit(context, property, "review", draft)).toMatchObject({
        state: "uncertain",
        reason: "confirmation_pending",
      });
      expect((await db.query("SELECT state FROM pms.guest_review_submissions")).rows[0].state).toBe(
        "uncertain",
      );
      vi.mocked(provider.check).mockResolvedValue({
        ...opportunity,
        state: "failed",
        reason: "provider_rejected",
      });
      expect(await commands.check(context, property, "review")).toMatchObject({
        state: "uncertain",
      });
      await commands.submit(context, property, "review", draft);
      expect(provider.send).toHaveBeenCalledTimes(1);
    },
  );
  it("never resends uncertain outcomes; read-back can confirm them", async () => {
    vi.mocked(provider.send).mockResolvedValue({ state: "uncertain" });
    expect(await commands.submit(context, property, "review", draft)).toMatchObject({
      state: "uncertain",
    });
    await commands.submit(context, property, "review", {
      ...draft,
      publicReview: "Different text",
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
    vi.mocked(provider.check).mockResolvedValue({ ...opportunity, state: "accepted" });
    expect(await commands.check(context, property, "review")).toMatchObject({ state: "accepted" });
    expect((await db.query("SELECT state FROM pms.guest_review_submissions")).rows[0].state).toBe(
      "accepted",
    );
  });
  it("retains failed input and allows an explicit retry after fresh eligibility check", async () => {
    vi.mocked(provider.send).mockResolvedValueOnce({
      state: "failed",
      reason: "provider_rejected",
    });
    await commands.submit(context, property, "review", { ...draft, publicReview: "Original text" });
    expect(await commands.check(context, property, "review")).toMatchObject({
      state: "ready",
      draft: { ...draft, publicReview: "Original text" },
    });
    await commands.submit(context, property, "review", draft);
    expect(provider.send).toHaveBeenCalledTimes(2);
  });
  it("retains history when discovery is empty or provider access disappears", async () => {
    await commands.submit(context, property, "review", draft);
    vi.mocked(provider.list).mockResolvedValue({ items: [], more: false });
    expect((await commands.list(context, property, 1)).stored[0]).toMatchObject({
      state: "accepted",
      draft,
    });
    await db.query("UPDATE pms.channel_connections SET connection_status = 'disconnected'");
    expect(await commands.check(context, property, "review")).toMatchObject({
      state: "accepted",
      draft,
    });
  });
  it("blocks retry after a provider mapping changes", async () => {
    vi.mocked(provider.send).mockResolvedValue({ state: "failed" });
    await commands.submit(context, property, "review", draft);
    await db.query("UPDATE pms.channel_connections SET external_property_id = 'new'");
    expect(await commands.submit(context, property, "review", draft)).toMatchObject({
      state: "unavailable",
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it("does not contact provider for a review outside the property", async () => {
    expect(await commands.submit(context, actor, "review", draft)).toMatchObject({
      state: "unavailable",
    });
    expect(provider.check).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
});
