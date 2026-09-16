import type { PoolClient } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { replayPricingAcceptance } from "./pricingAcceptanceReplay.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const fixture = () => {
  const row = acceptanceFixture();
  return {
    ...row,
    accepted_at: new Date(row.accepted_at),
    finance_terms_captured_at: new Date(row.finance_terms_captured_at),
    receipt_id: row.command_receipt_id,
    receipt_status: "completed",
    receipt_fingerprint: row.request_fingerprint_hash,
    response_status_code: 200,
    response_resource_product: "booking",
    response_resource_type: "guest_booking",
    response_resource_id: row.guest_booking_id,
    linked_booking_id: row.guest_booking_id,
    linked_booking_reference: "VAY-TESTBOOKING",
    linked_quote: row.quote_snapshot,
  };
};
const scope = {
  propertyId: acceptanceFixture().property_id,
  organizationId: acceptanceFixture().organization_id,
  authorityRevision: "authority:1",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(scope);
});
const client = (rows: unknown[]) =>
  ({ query: vi.fn().mockResolvedValue({ rows }) }) as unknown as PoolClient;
it("replays exact historical booking after quote expiry and normalizes retry names/email", async () => {
  const row = fixture(),
    db = client([row]);
  const input = {
    ...row.acceptance_command,
    guest: { ...row.acceptance_command.guest, firstName: " Jane ", email: "JANE@example.test" },
  };
  expect(await replayPricingAcceptance(db, "hotel", input)).toEqual({
    bookingId: row.guest_booking_id,
    bookingReference: row.linked_booking_reference,
    replayed: true,
  });
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE OF r"), [
    scope.propertyId,
    row.key_hash,
    scope.organizationId,
  ]);
  const sql = vi.mocked(db.query).mock.calls[0][0] as string;
  expect(sql).toContain("r.operation='booking.pricing_quote.accept'");
  expect(sql).toContain("r.tenant_scope='property'");
  expect(sql).not.toMatch(/UPDATE |INSERT |expires_at|current_uses/);
  expect(lockPublicPricingAuthority).toHaveBeenCalledTimes(2);
});
it("returns no receipt only after authority and never treats incomplete or broken evidence as success", async () => {
  const row = fixture();
  expect(await replayPricingAcceptance(client([]), "hotel", row.acceptance_command)).toBeNull();
  for (const patch of [
    { id: null },
    { receipt_status: "in_progress" },
    { receipt_status: "failed" },
    { receipt_fingerprint: "bad" },
    { linked_booking_id: null },
    { linked_booking_reference: null },
    { linked_booking_reference: "private" },
    { linked_quote: {} },
    { receipt_id: row.id },
    { organization_id: row.property_id },
    { response_resource_id: row.id },
    { response_resource_type: "payment" },
    { response_resource_product: "pms" },
    { response_status_code: 500 },
  ]) {
    await expect(
      replayPricingAcceptance(client([{ ...row, ...patch }]), "hotel", row.acceptance_command),
    ).rejects.toThrow("Booking acceptance unavailable");
  }
});
it("rejects changed command and lost authorization without disclosing historical guest data", async () => {
  const row = fixture();
  for (const input of [
    { ...row.acceptance_command, requestId: "other" },
    { ...row.acceptance_command, quoteId: row.id },
    {
      ...row.acceptance_command,
      guest: { ...row.acceptance_command.guest, email: "other@example.test" },
    },
    { ...row.acceptance_command, totalMinor: "1" },
    { requestId: "\n" },
  ]) {
    await expect(replayPricingAcceptance(client([row]), "hotel", input)).rejects.toThrow(
      "Booking acceptance unavailable",
    );
  }
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce(null);
  const db = client([row]);
  await expect(replayPricingAcceptance(db, "hotel", row.acceptance_command)).rejects.toThrow(
    "Booking acceptance unavailable",
  );
  expect(db.query).not.toHaveBeenCalled();
  vi.mocked(lockPublicPricingAuthority)
    .mockResolvedValueOnce(scope)
    .mockResolvedValueOnce({ ...scope, organizationId: row.id });
  await expect(
    replayPricingAcceptance(client([row]), "hotel", row.acceptance_command),
  ).rejects.toThrow("Booking acceptance unavailable");
});
