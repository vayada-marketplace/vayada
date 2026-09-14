import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const decode = (row: unknown) =>
  decodePricingAcceptanceHistory(
    row,
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000004",
  );
it("preserves expired historical prices, exact disclosure bytes, guest consent and fixed-plan nominal fees", () => {
  const row = acceptanceFixture(),
    result = decode(row)!;
  expect(result).not.toBeNull();
  expect(result.disclosureJson).toBe(row.disclosure_json);
  expect(result.quote.evidence).toEqual(row.quote_snapshot.evidence);
  expect(result.command).toEqual(row.acceptance_command);
  expect(result.commissionTerms.bookingEngineFeePercent).toBe(5);
  row.commission_terms_snapshot.bookingEngineFeePercent = 99;
  expect(result.commissionTerms.bookingEngineFeePercent).toBe(5);
});
it("rejects missing, crossed, corrupted or non-normalized identities and evidence", () => {
  const row = acceptanceFixture();
  for (const patch of [
    { property_id: row.organization_id },
    { organization_id: row.property_id },
    { id: "invalid" },
    { pricing_quote_id: row.id },
    { guest_booking_id: null },
    { command_receipt_id: null },
    { quote_snapshot: {} },
    { disclosure_json: "{" },
    { disclosure_hash: "sha256:bad" },
    { disclosure_json: row.disclosure_json + " " },
    { guest_policy_source_revision: "changed" },
    { request_id: "another" },
    { key_hash: "bad" },
    { request_fingerprint_hash: "bad" },
    {
      acceptance_command: {
        ...row.acceptance_command,
        guest: { ...row.acceptance_command.guest, firstName: " Jane " },
      },
    },
    { inventory_reservation_bundle: { ...row.inventory_reservation_bundle, receipts: [] } },
    { billing_plan_snapshot: "unknown" },
    { commission_terms_snapshot: {} },
    {
      commission_terms_snapshot: { ...row.commission_terms_snapshot, bookingEngineFeePercent: -1 },
    },
    { accepted_at: row.quote_snapshot.evidence.expiresAt },
    { accepted_at: "2026-08-01T00:00:00.000Z" },
    { finance_terms_captured_at: "2026-09-01T00:03:00.000Z" },
    {
      commission_terms_snapshot: {
        ...row.commission_terms_snapshot,
        financeConfigUpdatedAt: "2026-09-01T00:03:00.000Z",
      },
    },
  ])
    expect(decode({ ...row, ...patch }), JSON.stringify(patch)).toBeNull();
});
it("rejects rehashed malformed disclosure or changed quote instead of trusting a hash alone", () => {
  const row = acceptanceFixture();
  for (const patch of [
    { propertyTimeZone: "bad/zone" },
    { choices: {} },
    { version: "old" },
    { quote: {} },
    { private: true },
  ]) {
    const disclosure_json = JSON.stringify({ ...JSON.parse(row.disclosure_json), ...patch });
    expect(
      decode({ ...row, disclosure_json, disclosure_hash: `sha256:${hash(disclosure_json)}` }),
    ).toBeNull();
  }
});
