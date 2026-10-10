import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import {
  buildPmsGuestOperationsRecords,
  LEGACY_DEFAULT_TEMPLATE_STEPS,
  nativeTemplateSteps,
} from "./productionPmsGuestOperationsRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const ASSIGNMENT = "40000000-0000-4000-a000-000000000001";
const USER = "50000000-0000-4000-a000-000000000001";

describe("production PMS guest operations", () => {
  it("preserves templates, check-in/out evidence, charges, and private notes", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: target(),
    });
    const records = buildPmsGuestOperationsRecords(context, {
      records: [],
      assignmentByBookingPosition: new Map([[`${BOOKING}:1`, ASSIGNMENT]]),
    });
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable).sort()).toEqual([
      "booking_checkin_records",
      "booking_checkout_charges",
      "booking_checkout_records",
      "booking_notes_private",
      "checkin_checklist_templates",
      "checkout_inspection_templates",
    ]);
    expect(
      records.find((record) => record.targetTable === "booking_checkout_charges")?.row,
    ).toMatchObject({ assignmentId: ASSIGNMENT, currency: "EUR", status: "paid" });
    expect(
      records.find((record) => record.targetTable === "booking_notes_private")?.row,
    ).toMatchObject({ body: "Internal note", source: "pms", authorUserId: USER });
  });

  it("stores legacy checklist steps in the native shape the runtime reads (VAY-2112)", () => {
    expect(
      nativeTemplateSteps(
        [
          { id: "default-verify-guest-ids", label: " Verify IDs ", prompt: "p", type: "checkbox" },
          { key: "deposit", label: "Confirm deposit", required: true },
          { stepId: "keys", label: "Keys", required: false, position: 2 },
          { label: "No legacy ID" },
          { id: "keys", label: "Repeated ID" },
          { id: "has spaces", label: "Invalid ID" },
        ],
        "checkin",
      ),
    ).toEqual([
      { stepId: "default-verify-guest-ids", label: "Verify IDs", required: false },
      { stepId: "deposit", label: "Confirm deposit", required: true },
      { stepId: "keys", label: "Keys", required: false },
      { stepId: "legacy-step-4", label: "No legacy ID", required: false },
      { stepId: "legacy-step-5", label: "Repeated ID", required: false },
      { stepId: "legacy-step-6", label: "Invalid ID", required: false },
    ]);
    // Legacy check-out steps default to required; a JSON string array reads the same.
    expect(
      nativeTemplateSteps(JSON.stringify([{ id: "minibar", label: "Minibar" }]), "checkout"),
    ).toEqual([{ stepId: "minibar", label: "Minibar", required: true }]);
    expect(nativeTemplateSteps(null, "checkin")).toEqual([]);
    for (const invalid of [
      [{ id: "unlabelled" }],
      [{ id: "blank", label: "  " }],
      ["not an object"],
    ])
      expect(() => nativeTemplateSteps(invalid, "checkin")).toThrow();
    // The runtime reader has no step limit: a long legacy template is carried whole.
    const long = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, label: "Step" }));
    expect(nativeTemplateSteps(long, "checkin")).toHaveLength(51);
  });

  it("follows the native template step contract (drift guard)", async () => {
    const api = join(import.meta.dirname, "../../../apps/api/src");
    const route = await readFile(join(api, "routes/pmsOperations.ts"), "utf8");
    const reader = await readFile(join(api, "domains/pmsOperationsCommandRepository.ts"), "utf8");
    expect(route).toContain("/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(stepId)");
    expect(route).toContain("label.length > 200");
    expect(route).toContain("steps.push({ stepId, label, required: raw.required === true });");
    expect(reader).toContain(
      'if (typeof step.stepId !== "string" || typeof step.label !== "string") return null;',
    );
  });

  it("gives a carried cohort hotel without a legacy template legacy's built-in steps", () => {
    const templates = (cohort: { pmsHotelIds: string[] } | null, keep: string[] = []) => {
      const sourceRows = [
        row("hotels", { id: HOTEL }),
        ...rows().filter(
          (entry) => !entry.sourceTable.endsWith("_templates") || keep.includes(entry.sourceTable),
        ),
      ];
      const context = createProductionPmsContext({
        sourceRunId: "run",
        completedAt: "2026-08-30T00:00:00Z",
        rows: sourceRows,
        target: target(),
        ...(cohort
          ? { cohort: { bookingHotelIds: [PROPERTY], marketplaceHotelIds: [], ...cohort } }
          : {}),
      });
      const records = buildPmsGuestOperationsRecords(context, {
        records: [],
        assignmentByBookingPosition: new Map([[`${BOOKING}:1`, ASSIGNMENT]]),
      });
      expect(context.blockers).toEqual([]);
      return Object.fromEntries(
        records
          .filter((record) => record.targetTable.endsWith("_templates"))
          .map((record) => [record.targetTable, record.row["steps"]]),
      );
    };
    expect(templates({ pmsHotelIds: [HOTEL] })).toEqual({
      checkin_checklist_templates: LEGACY_DEFAULT_TEMPLATE_STEPS.checkin,
      checkout_inspection_templates: LEGACY_DEFAULT_TEMPLATE_STEPS.checkout,
    });
    // A legacy row wins; hotels outside the cohort and runs without one get nothing.
    expect(templates({ pmsHotelIds: [HOTEL] }, ["checkin_checklist_templates"])).toEqual({
      checkin_checklist_templates: [{ stepId: "id", label: "Verify ID", required: false }],
      checkout_inspection_templates: LEGACY_DEFAULT_TEMPLATE_STEPS.checkout,
    });
    expect(templates({ pmsHotelIds: [] })).toEqual({});
    expect(templates(null)).toEqual({});
  });

  it("blocks missing target users", () => {
    const targetState = target();
    targetState.userIds = [];
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: targetState,
    });
    buildPmsGuestOperationsRecords(context, {
      records: [],
      assignmentByBookingPosition: new Map([[`${BOOKING}:1`, ASSIGNMENT]]),
    });
    expect(
      context.blockers.some((blocker) => blocker.message.includes("missing target user")),
    ).toBe(true);
  });
});

function rows(): IdentitySourceRow[] {
  return [
    row("bookings", {
      id: BOOKING,
      hotel_id: HOTEL,
      check_in: "2026-09-01",
      check_out: "2026-09-03",
      adults: 2,
      children: 0,
      number_of_rooms: 1,
      currency: "EUR",
      status: "checked_out",
      updated_at: "2026-09-03T11:00:00Z",
    }),
    row("checkin_checklist_templates", {
      hotel_id: HOTEL,
      steps: [{ key: "id", label: "Verify ID" }],
      updated_by: USER,
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("checkout_inspection_templates", {
      hotel_id: HOTEL,
      steps: [{ key: "keys", label: "Collect keys" }],
      updated_by: USER,
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("booking_checkin_records", {
      id: "60000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      completed_by: USER,
      completed_at: "2026-09-01T14:00:00Z",
      step_results: [],
      pending_flags: [],
    }),
    row("booking_checkout_charges", {
      id: "70000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      hotel_id: HOTEL,
      label: "Minibar",
      amount: "10.00",
      original_amount: "10.00",
      status: "paid",
      created_by: USER,
      created_at: "2026-09-03T10:00:00Z",
      settled_at: "2026-09-03T11:00:00Z",
    }),
    row("booking_checkout_records", {
      id: "80000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      completed_by: USER,
      completed_at: "2026-09-03T11:00:00Z",
      inspection_results: [],
      charges_settled: [],
      pending_flags: [],
      checkout_notes: "Done",
    }),
    row("booking_notes", {
      id: "90000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      hotel_id: HOTEL,
      author_user_id: USER,
      author_name: "Operator",
      body: "Internal note",
      source: "booking-detail",
      created_at: "2026-08-20T00:00:00Z",
    }),
  ];
}

function target() {
  return {
    propertyLinks: [
      {
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: "run",
        ownerStatus: "active",
      },
    ],
    bookings: [
      {
        id: BOOKING,
        propertyId: PROPERTY,
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        adults: 2,
        children: 0,
        roomCount: 1,
        currency: "EUR",
        lifecycleStatus: "completed",
        updatedAt: "2026-09-03T11:00:00Z",
        migrationRunId: "run",
      },
    ],
    userIds: [USER],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
