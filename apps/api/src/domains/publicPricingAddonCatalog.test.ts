import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { createPublicPricingAddonCatalog } from "./publicPricingAddonCatalog.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
vi.mock("./publicPricingPublication.js", () => ({ lockPublicPricingPublication: vi.fn() }));
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const id = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const scope = { propertyId, organizationId: id, authorityRevision: id };
const definition = () => ({
  id,
  name: "Breakfast",
  status: "active",
  public_visible: true,
  currency: "EUR",
  pricing_model: "per_guest_night",
  amount: "12.50",
  metadata: { maxQuantity: 120, maxGuests: 4 },
  ownership_kind: "partner",
  commission: "10",
  source: "private owner source",
});
function fixture(rows = [definition()], show = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT show_addons_step"))
      return { rows: [{ show_addons_step: show }], rowCount: 1 };
    if (sql.includes("SELECT id FROM booking.addon_definitions"))
      return { rows: rows.map(({ id }) => ({ id })), rowCount: rows.length };
    if (sql.includes("FROM booking.addon_definitions a")) return { rows, rowCount: rows.length };
    return { rows: [{ id: propertyId }], rowCount: 1 };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { read: () => createPublicPricingAddonCatalog(pool).read("hotel"), query, release };
}
beforeEach(() => {
  vi.mocked(lockPublicPricingPublication)
    .mockReset()
    .mockResolvedValue({
      scope,
      publication: { currency: "EUR" },
    } as NonNullable<Awaited<ReturnType<typeof lockPublicPricingPublication>>>);
  vi.mocked(lockPublicPricingAuthority).mockReset().mockResolvedValue(scope);
});
it("projects only current public selection metadata through the real add-on owner validator", async () => {
  const f = fixture();
  expect(await f.read()).toEqual({
    version: "public-pricing-addons.v1",
    addons: [
      {
        id,
        name: "Breakfast",
        currency: "EUR",
        pricingModel: "per_guest_night",
        maxQuantity: 99,
        maxGuests: 4,
      },
    ],
  });
  const discovery = f.query.mock.calls.findIndex(([sql]) =>
    sql.includes("SELECT id FROM booking.addon_definitions"),
  );
  expect(
    f.query.mock.calls.findIndex(([sql]) => sql.includes("properties WHERE id=$1 FOR UPDATE")),
  ).toBeLessThan(discovery);
  expect(f.query.mock.calls[discovery][0]).toContain(
    "status='active' AND public_visible=true AND currency=$2",
  );
  expect(f.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
});
it("honors the current Booking visibility switch and excludes unsupported lead-time rules", async () => {
  const hidden = fixture(undefined, false);
  expect((await hidden.read())?.addons).toEqual([]);
  expect(
    hidden.query.mock.calls.some(([sql]) =>
      sql.includes("SELECT id FROM booking.addon_definitions"),
    ),
  ).toBe(false);
  expect(
    hidden.query.mock.calls.filter(([sql]) => sql.includes("FROM booking.addon_definitions a")),
  ).toHaveLength(1);
  const row = definition();
  Object.assign(row.metadata, { leadTime: "24 hours" });
  expect((await fixture([row]).read())?.addons).toEqual([]);
});
it("fails closed for malformed or stale add-on evidence", async () => {
  for (const change of [
    { currency: "USD" },
    { status: "retired" },
    { public_visible: false },
    { amount: "1.001" },
    { metadata: { maxQuantity: 0 } },
    { pricing_model: "unknown" },
  ]) {
    expect(
      await fixture([{ ...definition(), ...change } as ReturnType<typeof definition>]).read(),
    ).toBeNull();
  }
  expect(await fixture(Array.from({ length: 100 }, () => definition())).read()).toBeNull();
});
it("does not discover extras without current pricing and rechecks public scope after owner waits", async () => {
  vi.mocked(lockPublicPricingPublication).mockResolvedValueOnce(null);
  const missing = fixture();
  expect(await missing.read()).toBeNull();
  expect(missing.query.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "ROLLBACK",
  ]);
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce(null);
  expect(await fixture().read()).toBeNull();
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce({ ...scope, propertyId: id });
  expect(await fixture().read()).toBeNull();
});
it("releases the transaction after an owner failure", async () => {
  vi.mocked(lockPublicPricingAuthority).mockRejectedValueOnce(new Error("database unavailable"));
  const f = fixture();
  await expect(f.read()).rejects.toThrow("database unavailable");
  expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
});

it("validates a catalogue larger than one quote selection without truncating or leaking economics", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...definition(),
    id: `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`,
  }));
  const f = fixture(rows);
  const result = await f.read();
  expect(result?.addons.map((addon) => addon.id)).toEqual(rows.map((row) => row.id));
  for (const addon of result!.addons)
    expect(Object.keys(addon).sort()).toEqual([
      "currency",
      "id",
      "maxGuests",
      "maxQuantity",
      "name",
      "pricingModel",
    ]);
  expect(
    f.query.mock.calls.filter(([sql]) => sql.includes("FROM booking.addon_definitions a")),
  ).toHaveLength(2);
  rows[99].amount = "1.001";
  expect(await fixture(rows).read()).toBeNull();
});
