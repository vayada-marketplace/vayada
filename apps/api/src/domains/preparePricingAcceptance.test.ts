import type { PoolClient } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { preparationFixture } from "./preparePricingAcceptance.fixtures.js";
import { preparePricingAcceptance } from "./preparePricingAcceptance.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { replayPricingAcceptance } from "./pricingAcceptanceReplay.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./pricingAcceptanceReplay.js", () => ({ replayPricingAcceptance: vi.fn() }));
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
vi.mock("./currentQuoteGuestDisclosure.js", () => ({ lockCurrentQuoteGuestDisclosure: vi.fn() }));
vi.mock("./financePricingAcceptanceTerms.js", () => ({
  lockFinancePricingAcceptanceTerms: vi.fn(),
}));
let f: ReturnType<typeof preparationFixture>;
const query = vi.fn();
const db = { query } as unknown as PoolClient;
beforeEach(() => {
  vi.resetAllMocks();
  f = preparationFixture();
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(f.current.scope);
  vi.mocked(replayPricingAcceptance).mockResolvedValue(null);
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue(f.current);
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(f.disclosure);
  vi.mocked(lockFinancePricingAcceptanceTerms).mockResolvedValue(f.finance);
  query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("INSERT") ? [{ id: "receipt" }] : [],
  }));
});
it("reserves an incomplete receipt after validating current owners and normalized consent", async () => {
  const result = await preparePricingAcceptance(db, "hotel", f.input);
  expect(result).toMatchObject({ kind: "fresh", commandReceiptId: "receipt", command: f.command });
  const call = query.mock.calls.find(([sql]) => sql.startsWith("INSERT"))!;
  expect(call[0]).toContain("'in_progress'");
  expect(call[1]).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}$/),
    f.command.fingerprint.slice(7),
    f.current.scope.propertyId,
    f.command.requestId,
  ]);
  expect(lockPublicPricingAuthority).toHaveBeenCalledBefore(vi.mocked(replayPricingAcceptance));
});
it("returns completed historical replay without touching fresh pricing or receipts", async () => {
  vi.mocked(replayPricingAcceptance).mockResolvedValue({
    bookingId: f.bookingId,
    bookingReference: "VAY-HISTORICAL",
    replayed: true,
  });
  expect(await preparePricingAcceptance(db, "hotel", f.input)).toEqual({
    kind: "replayed",
    bookingId: f.bookingId,
    bookingReference: "VAY-HISTORICAL",
    replayed: true,
  });
  expect(lockCurrentQuoteRevalidation).not.toHaveBeenCalled();
  expect(lockCurrentQuoteGuestDisclosure).not.toHaveBeenCalled();
  expect(lockFinancePricingAcceptanceTerms).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it.each([
  "accepted",
  "consent",
  "quote",
  "finance",
  "request",
  "card",
  "missing-charges",
  "receipt-conflict",
  "authority",
])("rejects %s", async (scenario) => {
  if (scenario === "accepted") query.mockResolvedValue({ rows: [{ id: "prior" }] });
  if (scenario === "consent") f.input.acceptance.quoteEvidenceId = "wrong";
  if (scenario === "quote") vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue(null);
  if (scenario === "finance") vi.mocked(lockFinancePricingAcceptanceTerms).mockResolvedValue(null);
  if (scenario === "request") Object.assign(f.current.quote, { acceptanceMode: "request" });
  if (scenario === "card") Object.assign(f.current.quote, { paymentMethod: "card" });
  if (scenario === "missing-charges") Object.assign(f.current, { calculation: undefined });
  if (scenario === "receipt-conflict") query.mockResolvedValue({ rows: [] });
  if (scenario === "authority")
    vi.mocked(lockPublicPricingAuthority)
      .mockResolvedValueOnce(f.current.scope)
      .mockResolvedValue(null);
  await expect(preparePricingAcceptance(db, "hotel", f.input)).rejects.toThrow("unavailable");
  if (!["receipt-conflict", "authority"].includes(scenario))
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
