import { describe, expect, it } from "vitest";

import {
  planNightlyRevenueBackfill,
  type NightlyRevenueBackfillCandidate,
} from "./bookingNightlyRevenueBackfill.js";
describe("nightly revenue backfill planner", () => {
  it("prefers exact evidence, reconciles sources, and reports retained-total drift", () => {
    const direct = candidate("direct-1", "direct", "EUR", "EUR");
    direct.retainedEvidence.exactNightly = exact("100", "110");
    direct.retainedEvidence.grossRoomTotal = "210";
    const ota = candidate("ota-1", "ota", "GBP", "GBP");
    ota.retainedEvidence.exactNightly = exact("70", "80");
    ota.retainedEvidence.grossRoomTotal = "151";
    const plan = run([ota, direct]);
    expect(plan.reconciliation.map(({ grossRoomAmount }) => grossRoomAmount).join(",")).toBe(
      "100.0000,110.0000,70.0000,80.0000",
    );
    expect(plan.exceptions[0]).toMatchObject({
      code: "retained_total_mismatch",
      amounts: { expected: "151.0000", planned: "150.0000", delta: "-1.0000" },
    });
  });
  it("requires inference approval and allocates only exact per-room stay spans", () => {
    const manual = candidate("manual-1", "manual", "EUR", "EUR", 2);
    manual.checkOut = "2026-09-17";
    manual.assignments[1]!.checkIn = "2026-09-15";
    manual.assignments[1]!.checkOut = "2026-09-17";
    manual.retainedEvidence.grossRoomTotal = "100.0001";
    const blocked = run([manual], false);
    expect(blocked.lines.every(({ grossRoomAmount }) => grossRoomAmount === null)).toBe(true);
    expect(blocked.exceptions[0]?.code).toBe("inference_not_approved");
    const allocated = run([manual]).lines.map(
      ({ stayDate, linePosition, grossRoomAmount }) =>
        `${stayDate}:${linePosition}:${grossRoomAmount}`,
    );
    expect(allocated.join(",")).toBe(
      "2026-09-14:1:25.0001,2026-09-15:1:25.0000,2026-09-15:2:25.0000,2026-09-16:2:25.0000",
    );
  });
  it("surfaces missing and currency-mismatched evidence without conversion", () => {
    const missing = candidate("migration-1", "migration", "EUR", null);
    const mismatch = candidate("ota-2", "ota", "EUR", "USD");
    mismatch.retainedEvidence.exactNightly = exact("100", "100");
    const plan = run([missing, mismatch]);
    expect(plan.exceptions.map(({ code }) => code).join(",")).toBe(
      "missing_evidence,currency_mismatch",
    );
    expect(plan.lines.every(({ evidenceQuality }) => evidenceQuality === "missing")).toBe(true);
  });
  it("uses exact snapshots for summary-only scope and reports header coverage drift", () => {
    const summary = candidate("summary", "manual", "EUR", "EUR");
    summary.assignments[0]!.stayEvidenceKind = "summary_only";
    summary.retainedEvidence.exactNightly = exact("10", "20");
    expect(run([summary])).toMatchObject({
      lines: [{ evidenceQuality: "exact" }, { evidenceQuality: "exact" }],
      exceptions: [],
    });
    const drift = candidate("drift", "manual", "EUR", "EUR");
    drift.checkOut = "2026-09-17";
    drift.retainedEvidence.grossRoomTotal = "30";
    expect(run([drift]).exceptions[0]?.code).toBe("assignment_scope_mismatch");
  });
  it("rejects incomplete and malformed booking scope without throwing", () => {
    const incomplete = candidate("incomplete", "manual", "EUR", null, 2);
    incomplete.assignments.pop();
    const malformed = candidate("bad-date", "manual", "EUR", null);
    malformed.checkIn = "2026-13-01";
    for (const invalid of [incomplete, malformed])
      expect(run([invalid])).toMatchObject({
        lines: [],
        exceptions: [{ code: "invalid_booking_scope" }],
      });
  });
  it("makes replay stable and source corrections detectable", () => {
    const source = candidate("migration-2", "migration", "EUR", "EUR");
    source.retainedEvidence.grossRoomTotal = "99.99";
    const first = run([source]);
    expect(run([source]).fingerprint).toBe(first.fingerprint);
    source.retainedEvidence.grossRoomTotal = "109.99";
    const corrected = run([source]);
    expect(corrected.fingerprint).not.toBe(first.fingerprint);
    expect(corrected.lines[0]?.evidenceFingerprint).not.toBe(first.lines[0]?.evidenceFingerprint);
  });
});
function run(candidates: NightlyRevenueBackfillCandidate[], allowInferredEqualAllocation = true) {
  return planNightlyRevenueBackfill(candidates, { allowInferredEqualAllocation });
}
function candidate(
  guestBookingId: string,
  sourceKind: NightlyRevenueBackfillCandidate["sourceKind"],
  currency: string,
  evidenceCurrency: string | null,
  roomCount = 1,
): NightlyRevenueBackfillCandidate {
  return {
    propertyId: "00000000-0000-4000-8000-000000000001",
    guestBookingId,
    checkIn: "2026-09-14",
    checkOut: "2026-09-16",
    roomCount,
    currency,
    lifecycleStatus: "confirmed",
    sourceKind,
    assignments: Array.from({ length: roomCount }, (_, index) => ({
      position: index + 1,
      roomTypeId: `room-${index + 1}`,
      stayEvidenceKind: "exact",
      checkIn: "2026-09-14",
      checkOut: "2026-09-16",
    })),
    retainedEvidence: { currency: evidenceCurrency },
  };
}
function exact(first: string, second: string) {
  return [
    { position: 1, stayDate: "2026-09-14", grossRoomAmount: first },
    { position: 1, stayDate: "2026-09-15", grossRoomAmount: second },
  ];
}
