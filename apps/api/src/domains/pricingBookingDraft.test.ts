import { replacementStayKey } from "@vayada/domain-booking";
import type { PoolClient } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { stagePricingBookingDraft } from "./pricingBookingDraft.js";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { persistPricingBookingAddons } from "./persistPricingBookingAddons.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./persistPricingBookingAddons.js", () => ({ persistPricingBookingAddons: vi.fn() }));
let input: Parameters<typeof stagePricingBookingDraft>[2];
const query = vi.fn(
  async (sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    void _values;
    if (sql.startsWith("SELECT id,payload"))
      return {
        rowCount: 1,
        rows: [
          {
            id: input.current.quote.quoteId,
            payload: {
              quote: input.current.quote,
              calculation: { version: "booking.quote-calculation.v1" },
            },
          },
        ],
      };
    return { rows: [], rowCount: 1 };
  },
);
const client = { query } as unknown as PoolClient;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(persistPricingBookingAddons).mockResolvedValue({ count: 0, replayed: false });
  input = pricingDraftFixture();
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(input.current.scope);
});
it("stages exact draft/booker fields without legacy quote records or lifecycle effects", async () => {
  expect(await stagePricingBookingDraft(client, "hotel", input)).toEqual({
    bookingId: input.bookingId,
    publicReference: input.publicReference,
  });
  const [sql, values] = query.mock.calls.find(([sql]) => sql.startsWith("WITH draft"))!;
  expect(sql).toContain("'draft','unpaid','pay_at_property'");
  expect(sql).not.toMatch(/quote_sessions|checkout_contexts|platform.jobs|confirmed/);
  expect(values?.slice(3, 10)).toEqual(["2026-10-01", "2026-10-03", 2, 1, 1, "EUR", "360.00"]);
  expect(values?.[10]).toMatchObject({
    pricingQuoteId: input.current.quote.quoteId,
    pricingSelections: input.current.quote.stay.rooms,
  });
  expect(values?.slice(14)).toEqual(["Jane", "Guest", "jane@example.test", null, null, null, null]);
  expect(values?.[12]).toEqual(input.finance.commissionTermsSnapshot);
  expect(persistPricingBookingAddons).toHaveBeenCalledWith(
    client,
    "hotel",
    input.current,
    input.bookingId,
  );
});
it.each(["scope", "finance", "hash", "quote", "policy", "money", "guest"])(
  "rejects changed %s evidence before inserts",
  async (kind) => {
    if (kind === "scope")
      vi.mocked(lockPublicPricingAuthority).mockResolvedValue({
        ...input.current.scope,
        organizationId: "foreign",
      });
    if (kind === "finance") input.finance.commissionTermsSnapshot.bookingEngineFeePercent = NaN;
    if (kind === "hash") input.command.fingerprint = "sha256:" + "0".repeat(64);
    if (kind === "quote")
      input.disclosure = {
        ...input.disclosure,
        quote: { ...input.disclosure.quote, quoteId: "foreign" },
      };
    if (kind === "policy") input.disclosure.disclosureJson += " ";
    if (kind === "money")
      input.current = {
        ...input.current,
        quote: { ...input.current.quote, paymentMethod: "card" },
      };
    if (kind === "guest") input.command.guest.email = " Jane@example.test ";
    await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow("unavailable");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("WITH draft"))).toBe(false);
  },
);
it("propagates insert failures and late authorization loss for caller rollback", async () => {
  query
    .mockImplementationOnce(query.getMockImplementation()!)
    .mockRejectedValueOnce(new Error("database failed"));
  await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow("database failed");
  vi.mocked(lockPublicPricingAuthority)
    .mockResolvedValueOnce(input.current.scope)
    .mockResolvedValueOnce(null);
  await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow("unavailable");
  expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
});

it("rejects an unavailable internal affiliate context before inserting a draft", async () => {
  input.syntheticAffiliateContextId = "unavailable-synthetic-context";
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (sql, values) => {
    if (sql === "SHOW transaction_isolation")
      return { rows: [{ transaction_isolation: "read committed" }], rowCount: 1 };
    if (sql.startsWith("SELECT id FROM booking.affiliate_click_contexts"))
      return { rows: [], rowCount: 0 };
    return original(sql, values);
  });
  await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow("unavailable");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("WITH draft"))).toBe(false);
});

it.each([
  ["JPY", "36000", "36000.00"],
  ["KWD", "36000", "36.00"],
  ["KWD", "36001", null],
  ["EUR", "1000000000000000", null],
])(
  "preserves %s minor amount %s exactly or rejects incompatible numeric(15,2)",
  async (currency, total, expected) => {
    input = pricingDraftFixture((quote) => {
      Object.assign(quote.stay, { currency });
      Object.assign(quote.evidence, {
        currency,
        totalMinor: total,
        dueLaterMinor: total,
        requestKey: replacementStayKey(quote.stay),
      });
      const roomTotal = BigInt(total!) - 6000n;
      Object.assign(quote.evidence.lines[0], { amountMinor: roomTotal.toString() });
      quote.rooms[0].nights.forEach((night, index) => {
        const room = index === 0 ? roomTotal / 2n : roomTotal - roomTotal / 2n;
        Object.assign(night, { roomMinor: room.toString(), totalMinor: (room + 3000n).toString() });
      });
    });
    vi.mocked(lockPublicPricingAuthority).mockResolvedValue(input.current.scope);
    if (expected === null) {
      await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow("unavailable");
      expect(query.mock.calls.some(([sql]) => sql.startsWith("WITH draft"))).toBe(false);
    } else {
      await stagePricingBookingDraft(client, "hotel", input);
      expect(query.mock.calls.find(([sql]) => sql.startsWith("WITH draft"))?.[1]?.[9]).toBe(
        expected,
      );
    }
  },
);

it("propagates add-on staging failures for full caller rollback", async () => {
  vi.mocked(persistPricingBookingAddons).mockRejectedValueOnce(new Error("extras unavailable"));
  await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow(
    "extras unavailable",
  );
  expect(query.mock.calls.some(([sql]) => sql.startsWith("WITH draft"))).toBe(true);
  expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
});

it.each(["instant", "request"] as const)(
  "preserves frozen %s mode on the draft",
  async (acceptanceMode) => {
    input = pricingDraftFixture((quote) => Object.assign(quote, { acceptanceMode }));
    vi.mocked(lockPublicPricingAuthority).mockResolvedValue(input.current.scope);
    await stagePricingBookingDraft(client, "hotel", input);
    expect(query.mock.calls.find(([sql]) => sql.startsWith("WITH draft"))?.[1]?.[10]).toMatchObject(
      { acceptanceMode },
    );
  },
);
it("refuses a fresh draft from an old quote without a frozen acceptance mode", async () => {
  input = pricingDraftFixture((quote) => {
    Reflect.deleteProperty(quote, "acceptanceMode");
  });
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(input.current.scope);
  await expect(stagePricingBookingDraft(client, "hotel", input)).rejects.toThrow("unavailable");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("WITH draft"))).toBe(false);
});
