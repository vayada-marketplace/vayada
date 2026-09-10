import { expect, it } from "vitest";
import {
  selectLastEligibleAffiliateClick as select,
  type AffiliateClickCandidate,
} from "./affiliateAttribution.js";
const click = (overrides: Partial<AffiliateClickCandidate> = {}): AffiliateClickCandidate => ({
  bookingId: "booking-1",
  propertyId: "hotel-1",
  clickId: "click-1",
  linkId: "link-1",
  creatorProfileId: "creator-1",
  agreementId: "agreement-1",
  termsVersionId: "terms-1",
  clickedAt: "2026-09-09T12:00:00Z",
  attributionWindowDays: 14,
  eligibility: "eligible",
  isTest: false,
  ...overrides,
});
const input = (candidates: AffiliateClickCandidate[]) => ({
  bookingId: "booking-1",
  propertyId: "hotel-1",
  bookedAt: "2026-09-10T12:00:00Z",
  evidenceComplete: true,
  candidates,
});
it("selects the last eligible click independently of input order and retains exact agreement terms", () => {
  const older = click();
  const newer = click({
    clickId: "click-2",
    creatorProfileId: "creator-2",
    agreementId: "agreement-2",
    termsVersionId: "terms-2",
    clickedAt: "2026-09-10T10:00:00Z",
  });
  const result = select(input([older, newer]));
  expect(result).toEqual({
    status: "attributed",
    bookingId: "booking-1",
    propertyId: "hotel-1",
    clickId: "click-2",
    linkId: "link-1",
    creatorProfileId: "creator-2",
    agreementId: "agreement-2",
    termsVersionId: "terms-2",
  });
  expect(select(input([newer, older]))).toEqual(result);
});
it("excludes unrelated bookings/properties, test and ineligible clicks without hiding the older eligible click", () => {
  const candidates = [
    click(),
    ...[
      { bookingId: "booking-2" },
      { propertyId: "hotel-2" },
      { isTest: true },
      { eligibility: "ineligible" as const },
    ].map((override, i) =>
      click({ clickId: `excluded-${i}`, clickedAt: "2026-09-10T11:00:00Z", ...override }),
    ),
  ];
  expect(select(input(candidates))).toMatchObject({ status: "attributed", clickId: "click-1" });
});
it.each([
  ["2026-08-27T12:00:00.000Z", "attributed"],
  ["2026-08-27T11:59:59.999Z", "unattributed"],
  ["2026-09-10T12:00:00.000Z", "attributed"],
  ["2026-09-10T12:00:00.001Z", "unattributed"],
])("applies exact original booking/window boundaries: %s", (clickedAt, status) => {
  expect(select(input([click({ clickedAt })]))).toMatchObject({ status });
});
it("uses each candidate's accepted window and never defaults one", () => {
  expect(
    select(input([click({ clickedAt: "2026-09-08T12:00:00Z", attributionWindowDays: 1 })])),
  ).toMatchObject({ status: "unattributed" });
  for (const attributionWindowDays of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN])
    expect(select(input([click({ attributionWindowDays })]))).toEqual({
      status: "needs_review",
      reason: "invalid_evidence",
    });
});
it("collapses identical duplicates and rejects conflicting click identities", () => {
  expect(select(input([click(), click({ clickedAt: "2026-09-09T12:00:00.000Z" })]))).toMatchObject({
    status: "attributed",
  });
  for (const override of [
    { creatorProfileId: "other" },
    { termsVersionId: "other" },
    { eligibility: "ineligible" as const },
    { isTest: true },
  ]) {
    const candidates = [click(), click(override)];
    expect(select(input(candidates))).toEqual({
      status: "needs_review",
      reason: "conflicting_click",
    });
    expect(select(input(candidates.reverse()))).toEqual({
      status: "needs_review",
      reason: "conflicting_click",
    });
  }
});
it("does not use array order or lexical IDs to break a tied latest click", () => {
  const candidates = [click(), click({ clickId: "other", creatorProfileId: "other" })];
  expect(select(input(candidates))).toEqual({
    status: "needs_review",
    reason: "ambiguous_last_click",
  });
  expect(select(input(candidates.reverse()))).toEqual({
    status: "needs_review",
    reason: "ambiguous_last_click",
  });
});
it("keeps incomplete evidence pending and unresolved eligible candidates under review", () => {
  expect(select({ ...input([click()]), evidenceComplete: false })).toEqual({
    status: "pending",
    reason: "incomplete_evidence",
  });
  expect(select({ ...input([]), evidenceComplete: false })).toEqual({
    status: "pending",
    reason: "incomplete_evidence",
  });
  expect(select(input([click({ eligibility: "unknown" })]))).toEqual({
    status: "needs_review",
    reason: "eligibility_unknown",
  });
  expect(
    select(input([click({ eligibility: "unknown", clickedAt: "2026-01-01T12:00:00Z" })])),
  ).toMatchObject({ status: "unattributed" });
  expect(select(input([]))).toEqual({ status: "unattributed", reason: "no_eligible_click" });
});
it("rejects impossible dates, implicit timezones and missing references instead of crediting", () => {
  for (const clickedAt of ["2026-02-30T12:00:00Z", "2026-09-09", "2026-09-09T12:00:00", "bad"])
    expect(select(input([click({ clickedAt })]))).toEqual({
      status: "needs_review",
      reason: "invalid_evidence",
    });
  expect(select(input([click({ agreementId: "" })]))).toMatchObject({ status: "needs_review" });
  expect(select({ ...input([click()]), bookedAt: "2026-02-30T12:00:00Z" })).toMatchObject({
    status: "needs_review",
  });
});
