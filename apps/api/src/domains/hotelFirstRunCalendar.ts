import {
  firstRunOperatingCalendarProposal,
  type FirstRunCalendarRoomType,
} from "@vayada/domain-booking";
import {
  createPmsOperatingCalendarSourceRevision,
  parsePreviewPmsOperatingCalendarImpactCommand,
  parseUpsertPmsOperatingCalendarCommand,
  type PmsInventoryMaterializationPort,
  type PmsOperatingCalendarCommandPort,
  type PmsOperatingCalendarImpactPreviewPort,
  type PmsOperatingCalendarReadPort,
} from "@vayada/domain-pms";

import {
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunStepOutcome,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 first run, step 5: open the calendar all year with a one-night minimum, then prepare the next 365
 * days of availability, as the setup screen does (preview the impact → save with its confirmation →
 * materialize). A current calendar is left alone; a stale one (rooms changed since) is saved again.
 */

export type HotelFirstRunCalendarPorts = Readonly<{
  calendarRead: Pick<PmsOperatingCalendarReadPort, "getCurrentOperatingCalendarConfiguration">;
  preview: PmsOperatingCalendarImpactPreviewPort;
  calendar: PmsOperatingCalendarCommandPort;
  materialization: PmsInventoryMaterializationPort;
}>;

export type HotelFirstRunCalendarInput = Readonly<{
  propertyProfileRevision: number;
  timezone: string | null;
  roomTypes: readonly FirstRunCalendarRoomType[];
  /** Whether the next 365 days are already prepared for the current calendar revision. */
  inventoryPrepared: boolean;
}>;

const fail = (code: string, cause?: unknown): HotelFirstRunStepOutcome =>
  Object.freeze({ ok: false, code, cause });

/** Today in the hotel's time zone through 365 days later, as the setup screen's inventoryHorizon. */
export function firstRunInventoryHorizon(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value;
  const from = `${part("year")}-${part("month")}-${part("day")}`;
  const through = new Date(Date.parse(`${from}T00:00:00.000Z`) + 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, through };
}

function audit(actor: HotelFirstRunActor) {
  return {
    actor: { kind: "user" as const, userId: actor.userId },
    requestId: actor.requestId,
    correlationId: actor.correlationId,
    requestedAt: actor.requestedAt,
  };
}

export async function runFirstRunCalendar(
  ports: HotelFirstRunCalendarPorts,
  actor: HotelFirstRunActor,
  input: HotelFirstRunCalendarInput,
): Promise<HotelFirstRunStepOutcome> {
  if (!input.timezone) return fail("property_timezone_missing");
  const current = await ports.calendarRead.getCurrentOperatingCalendarConfiguration(
    actor.propertyId,
  );
  let calendarRevision = current?.configuration.calendarRevision ?? 0;
  if (!current || current.sourceStatus === "stale") {
    const proposal = firstRunOperatingCalendarProposal({
      expectedCalendarRevision: calendarRevision,
      expectedPropertyProfileRevision: input.propertyProfileRevision,
      roomTypes: input.roomTypes,
    });
    if (!proposal) return fail("first_run_calendar_invalid");
    const scope = { organizationId: actor.organizationId, propertyId: actor.propertyId };
    const previewCommand = parsePreviewPmsOperatingCalendarImpactCommand({
      ...proposal,
      ...scope,
      audit: audit(actor),
    });
    if (!previewCommand) return fail("first_run_calendar_invalid");
    const preview = await ports.preview.previewOperatingCalendarImpact(previewCommand);
    if (!preview.ok) return fail("first_run_calendar_preview_failed", preview.error);
    const command = parseUpsertPmsOperatingCalendarCommand({
      ...proposal,
      ...scope,
      impactConfirmation: preview.preview.confirmation,
      idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "calendar", [
        calendarRevision,
        proposal,
      ]),
      audit: audit(actor),
    });
    if (!command) return fail("first_run_calendar_invalid");
    const saved = await ports.calendar.upsertOperatingCalendar(command);
    if (!saved.ok) return fail("first_run_calendar_failed", saved.error);
    calendarRevision = saved.response.configuration.calendarRevision;
  } else if (input.inventoryPrepared) {
    return Object.freeze({ ok: true, wrote: false });
  }

  const horizon = firstRunInventoryHorizon(actor.requestedAt, input.timezone);
  const materialized = await ports.materialization.materializeInventory({
    organizationId: actor.organizationId,
    propertyId: actor.propertyId,
    configurationSource: createPmsOperatingCalendarSourceRevision(
      actor.propertyId,
      calendarRevision,
    ),
    expectedMaterializedRevision: calendarRevision,
    horizon,
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "inventory", [
      calendarRevision,
      horizon,
    ]),
    audit: audit(actor),
  });
  if (!materialized.ok) return fail("first_run_inventory_failed", materialized.error);
  return Object.freeze({ ok: true, wrote: true });
}
