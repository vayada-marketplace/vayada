import { targetBooking } from "./productionPmsAssignmentRecords.js";
import { carriedCohortHotel } from "./productionPmsCohortSetup.js";
import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsAssignmentBuild, PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  currency,
  iso,
  money,
  optionalIso,
  optionalText,
  requiredText,
  uuid,
} from "./productionBookingValues.js";
import { jsonArray, optionalActor, pmsRecord } from "./productionPmsValues.js";

export function buildPmsGuestOperationsRecords(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  const builders: Record<string, (source: IdentitySourceRow) => PmsTargetRecord[]> = {
    checkin_checklist_templates: (source) => checklist(context, source, "checkin"),
    checkout_inspection_templates: (source) => checklist(context, source, "checkout"),
    booking_checkin_records: (source) => checkin(context, assignments, source),
    booking_checkout_charges: (source) => checkoutCharge(context, assignments, source),
    booking_checkout_records: (source) => checkout(context, assignments, source),
    booking_notes: (source) => privateNote(context, source),
  };
  for (const [table, build] of Object.entries(builders))
    for (const source of context.rowsByTable.get(table) ?? [])
      try {
        records.push(...build(source));
      } catch (error) {
        addPmsBlocker(
          context,
          "INVALID_SOURCE_ROW",
          `pms.${table}`,
          safePmsSourceId(source, table.includes("templates") ? "hotel_id" : "id"),
          error instanceof Error ? error.message : "Invalid PMS guest operation",
        );
      }
  const migratedAt = new Date(context.completedAt).toISOString();
  for (const { hotel, hotelId, propertyId, table, kind } of legacyDefaultTemplates(context)) {
    // An existing row keeps its time, so reruns plan nothing and a later native edit is kept.
    const current = context.target.records.find(
      (record) => record.targetTable === table && record.targetId === propertyId,
    );
    // A native template the migration never wrote stands.
    if (
      current &&
      !context.target.provenance.some(
        (link) => link.targetTable === table && link.targetId === propertyId,
      )
    )
      continue;
    records.push(
      pmsRecord(
        hotel,
        table,
        propertyId,
        migratedAt,
        true,
        {
          propertyId,
          steps: LEGACY_DEFAULT_TEMPLATE_STEPS[kind].map((step) => ({ ...step })),
          updatedByUserId: null,
          updatedAt: current?.updatedAt ?? migratedAt,
        },
        { id: hotelId, template: `${kind}_legacy_default` },
      ),
    );
  }
  return records;
}

/**
 * VAY-2112: legacy shows its built-in steps to a hotel without a template row (apps/pms-api
 * models/checkin.py DEFAULT_CHECKIN_CHECKLIST_STEPS, routers/admin_checkout.py
 * DEFAULT_INSPECTION_STEPS), all required, with these IDs, which its check-in and check-out
 * records reference. A carried cohort hotel keeps seeing them in the target.
 */
export const LEGACY_DEFAULT_TEMPLATE_STEPS = {
  checkin: [
    { stepId: "default-verify-guest-ids", label: "Verify guest IDs / passports", required: true },
    {
      stepId: "default-confirm-payment-status",
      label: "Confirm payment / deposit status",
      required: true,
    },
    { stepId: "default-room-access", label: "Assign room & hand over keys/access", required: true },
  ],
  checkout: [
    { stepId: "default-minibar", label: "Minibar", required: true },
    { stepId: "default-room-condition", label: "Room condition", required: true },
    { stepId: "default-keys-access", label: "Keys / access", required: true },
  ],
} as const;

/** Carried cohort hotels without a legacy template row of a kind. */
export function legacyDefaultTemplates(context: PmsBuildContext) {
  if (!context.cohort) return [];
  const result: Array<{
    hotel: IdentitySourceRow;
    hotelId: string;
    propertyId: string;
    table: "checkin_checklist_templates" | "checkout_inspection_templates";
    kind: "checkin" | "checkout";
  }> = [];
  for (const hotel of context.rowsByTable.get("hotels") ?? []) {
    const hotelId = String(hotel.data["id"] ?? "").toLowerCase();
    const propertyId = context.propertyByHotel.get(hotelId);
    if (!propertyId || !carriedCohortHotel(context, hotelId)) continue;
    for (const kind of ["checkin", "checkout"] as const) {
      const table =
        kind === "checkin" ? "checkin_checklist_templates" : "checkout_inspection_templates";
      if (
        !(context.rowsByTable.get(table) ?? []).some(
          (row) => String(row.data["hotel_id"] ?? "").toLowerCase() === hotelId,
        )
      )
        result.push({ hotel, hotelId, propertyId, table, kind });
    }
  }
  return result;
}

function checklist(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  kind: "checkin" | "checkout",
): PmsTargetRecord[] {
  const propertyId = propertyForHotel(context, source.data["hotel_id"]);
  const updatedAt = iso(source.data["updated_at"], "updated_at");
  const table =
    kind === "checkin" ? "checkin_checklist_templates" : "checkout_inspection_templates";
  return [
    pmsRecord(
      source,
      table,
      propertyId,
      updatedAt,
      true,
      {
        propertyId,
        steps: nativeTemplateSteps(source.data["steps"], kind),
        updatedByUserId: optionalActor(source.data["updated_by"], "updated_by", context.userIds),
        updatedAt,
      },
      // A row stored in the earlier legacy shape takes the update path instead of a mismatch.
      { ...source.data, nativeStepShape: 1 },
    ),
  ];
}

const STEP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;

/**
 * VAY-2112: the runtime reads a template step only in the shape the native template writer
 * stores (apps/api pmsOperations toOperationalTemplateSteps: `{ stepId, label, required }`,
 * trimmed, IDs unique); the repository's toPmsTemplateSteps drops any other step. Its reader has
 * no step limit, so a legacy template over the native save limit of 50 is carried whole.
 * Legacy keys the ID `id` (`key` in older rows) and defaults `required` to false for check-in
 * steps and true for check-out ones. A missing, invalid or repeated legacy ID takes the step's
 * position; a step without a label blocks, as legacy and the native writer require one.
 */
export function nativeTemplateSteps(
  value: unknown,
  kind: "checkin" | "checkout",
): Array<{ stepId: string; label: string; required: boolean }> {
  const steps = jsonArray(value, "steps");
  const seen = new Set<string>();
  return steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step))
      throw new Error(`template step ${index + 1} is not an object`);
    const raw = step as Record<string, unknown>;
    const label = typeof raw["label"] === "string" ? raw["label"].trim() : "";
    if (!label || label.length > 200)
      throw new Error(`template step ${index + 1} needs a label of 1 to 200 characters`);
    const legacyId = [raw["stepId"], raw["id"], raw["key"]]
      .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
      .find((candidate) => STEP_ID.test(candidate));
    const stepId = legacyId && !seen.has(legacyId) ? legacyId : `legacy-step-${index + 1}`;
    if (seen.has(stepId)) throw new Error(`template step ${index + 1} repeats step ID ${stepId}`);
    seen.add(stepId);
    const required = typeof raw["required"] === "boolean" ? raw["required"] : kind === "checkout";
    return { stepId, label, required };
  });
}

function checkin(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const bookingId = uuid(source.data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  const completedAt = iso(source.data["completed_at"], "completed_at");
  return [
    pmsRecord(source, "booking_checkin_records", id, completedAt, false, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      assignmentId: firstAssignment(assignments, bookingId),
      completedByUserId: optionalActor(
        source.data["completed_by"],
        "completed_by",
        context.userIds,
      ),
      completedAt,
      stepResults: jsonArray(source.data["step_results"], "step_results"),
      pendingFlags: jsonArray(source.data["pending_flags"], "pending_flags"),
    }),
  ];
}

function checkoutCharge(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const bookingId = uuid(data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  if (propertyForHotel(context, data["hotel_id"]) !== booking.propertyId)
    throw new Error("checkout charge crosses booking property scope");
  const status = requiredText(data["status"], "status").toLowerCase();
  if (!["pending", "paid", "waived"].includes(status))
    throw new Error(`checkout charge status ${status} is unsupported`);
  const createdAt = iso(data["created_at"], "created_at");
  const settledAt = optionalIso(data["settled_at"], "settled_at");
  const waivedAt = optionalIso(data["waived_at"], "waived_at");
  const sourceUpdatedAt = waivedAt ?? settledAt ?? createdAt;
  return [
    pmsRecord(source, "booking_checkout_charges", id, sourceUpdatedAt, true, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      assignmentId: firstAssignment(assignments, bookingId),
      label: requiredText(data["label"], "label"),
      amount: money(data["amount"], "amount"),
      originalAmount: money(data["original_amount"], "original_amount"),
      currency: currency(booking.target.currency),
      status,
      createdByUserId: optionalActor(data["created_by"], "created_by", context.userIds),
      createdAt,
      settledAt,
      waivedAt,
    }),
  ];
}

function checkout(
  context: PmsBuildContext,
  assignments: PmsAssignmentBuild,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const bookingId = uuid(source.data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  const completedAt = iso(source.data["completed_at"], "completed_at");
  return [
    pmsRecord(source, "booking_checkout_records", id, completedAt, false, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      assignmentId: firstAssignment(assignments, bookingId),
      completedByUserId: optionalActor(
        source.data["completed_by"],
        "completed_by",
        context.userIds,
      ),
      completedAt,
      inspectionResults: jsonArray(source.data["inspection_results"], "inspection_results"),
      chargesSettled: jsonArray(source.data["charges_settled"], "charges_settled"),
      pendingFlags: jsonArray(source.data["pending_flags"], "pending_flags"),
      checkoutNotes: optionalText(source.data["checkout_notes"], "checkout_notes"),
    }),
  ];
}

function privateNote(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const bookingId = uuid(data["booking_id"], "booking_id");
  const booking = targetBooking(context, bookingId);
  if (propertyForHotel(context, data["hotel_id"]) !== booking.propertyId)
    throw new Error("private note crosses booking property scope");
  const createdAt = iso(data["created_at"], "created_at");
  return [
    pmsRecord(source, "booking_notes_private", id, createdAt, true, {
      id,
      propertyId: booking.propertyId,
      guestBookingId: bookingId,
      authorUserId: optionalActor(data["author_user_id"], "author_user_id", context.userIds),
      authorDisplayName: optionalText(data["author_name"], "author_name") ?? "",
      body: requiredText(data["body"], "body"),
      source: "pms",
      createdAt,
      editedByUserId: null,
      editedByDisplayName: null,
      editedAt: null,
    }),
  ];
}

function firstAssignment(assignments: PmsAssignmentBuild, bookingId: string): string {
  const id = assignments.assignmentByBookingPosition.get(`${bookingId}:1`);
  if (!id) throw new Error(`booking ${bookingId} has no operational assignment`);
  return id;
}
