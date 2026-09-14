import { expect, it } from "vitest";
import {
  planOtaRevenueCorrections as plan,
  type CurrentOtaRevenueNight,
  type OtaRevenueNight,
} from "./bookingOtaRevenueCorrections.js";
const roomTypeId = "82000000-0000-4000-8000-000000000004";
const evidenceId = "82000000-0000-4000-8000-000000000005";
const desired: OtaRevenueNight = {
  roomTypeId,
  stayDate: "2026-09-01",
  linePosition: 1,
  grossRoomAmount: "100",
  evidenceQuality: "exact",
};
const current: CurrentOtaRevenueNight = {
  ...desired,
  evidenceId,
  recognizedOn: "2026-09-01",
  occupiedRoomNights: 1,
};
const day = "2026-09-10";

it("emits only the monetary delta and retains lineage", () => {
  expect(plan([current], [{ ...desired, grossRoomAmount: "80.1234" }], day)).toEqual([
    {
      roomTypeId,
      stayDate: desired.stayDate,
      linePosition: 1,
      recognizedOn: day,
      correctsEvidenceId: evidenceId,
      lifecycleState: "corrected",
      grossRoomAmount: "-19.8766",
      evidenceQuality: "exact",
      occupiedRoomNights: 0,
      economicEvent: "correction",
    },
  ]);
  expect(plan([current], [{ ...desired, grossRoomAmount: "100.0000" }], day)).toEqual([]);
});

it("removes old nights and adds new nights without spreading prices", () => {
  const result = plan(
    [current],
    [{ ...desired, stayDate: "2026-09-02", grossRoomAmount: null, evidenceQuality: "missing" }],
    day,
  );
  expect(result).toMatchObject([
    {
      stayDate: "2026-09-01",
      grossRoomAmount: "-100.0000",
      occupiedRoomNights: -1,
      correctsEvidenceId: evidenceId,
    },
    {
      stayDate: "2026-09-02",
      grossRoomAmount: null,
      evidenceQuality: "missing",
      occupiedRoomNights: 1,
      economicEvent: "room_night",
    },
  ]);
  expect(result[1]!.recognizedOn).toBe("2026-09-02");
});

it.each(["0", "125.0001"])("fills previously missing economics with %s", (grossRoomAmount) => {
  expect(
    plan(
      [{ ...current, grossRoomAmount: null, evidenceQuality: "missing" }],
      [{ ...desired, grossRoomAmount }],
      day,
    ),
  ).toMatchObject([
    {
      grossRoomAmount: grossRoomAmount === "0" ? "0.0000" : grossRoomAmount,
      economicEvent: "correction",
    },
  ]);
});

it("restores a removed night and preserves a later recognition date", () => {
  expect(
    plan(
      [{ ...current, occupiedRoomNights: 0, grossRoomAmount: "0", recognizedOn: "2026-09-12" }],
      [desired],
      day,
    ),
  ).toMatchObject([
    {
      occupiedRoomNights: 1,
      economicEvent: "occupancy_adjustment",
      recognizedOn: "2026-09-12",
      correctsEvidenceId: evidenceId,
    },
  ]);
});

it("does not restore missing economics over a known zero aggregate", () => {
  const removed = { ...current, occupiedRoomNights: 0 as const, grossRoomAmount: "0" };
  const missing = { ...desired, grossRoomAmount: null, evidenceQuality: "missing" as const };
  expect(() => plan([removed], [missing], day)).toThrow(
    "alteration_revenue_correction_unsupported",
  );
  expect(
    plan([{ ...removed, grossRoomAmount: null, evidenceQuality: "missing" }], [missing], day),
  ).toMatchObject([{ grossRoomAmount: null, evidenceQuality: "missing", occupiedRoomNights: 1 }]);
});

it("uses exact arithmetic at the ledger limit", () => {
  expect(
    plan(
      [{ ...current, grossRoomAmount: "999999999999999.9998" }],
      [{ ...desired, grossRoomAmount: "999999999999999.9999" }],
      day,
    ),
  ).toMatchObject([{ grossRoomAmount: "0.0001" }]);
});

it.each([
  { grossRoomAmount: null, evidenceQuality: "missing" as const },
  { roomTypeId: evidenceId },
  { evidenceQuality: "inferred" as const },
  { grossRoomAmount: "-1" },
  { grossRoomAmount: "1e2" },
  { stayDate: "2026-02-30" },
])("rejects unsupported or malformed economics (%j)", (override) => {
  expect(() => plan([current], [{ ...desired, ...override }], day)).toThrow(
    "alteration_revenue_correction_unsupported",
  );
});

it("rejects duplicate identities, invalid current aggregates and unbounded plans", () => {
  for (const [before, after] of [
    [[current, current], [desired]],
    [[current], [desired, desired]],
    [[{ ...current, occupiedRoomNights: 0 }], [desired]],
    [[current], []],
    [[], Array(1001).fill(desired)],
  ] as [CurrentOtaRevenueNight[], OtaRevenueNight[]][])
    expect(() => plan(before, after, day)).toThrow("alteration_revenue_correction_unsupported");
  expect(() => plan([current], [desired], "PRIVATE GUEST")).toThrow(
    "alteration_revenue_correction_unsupported",
  );
});
