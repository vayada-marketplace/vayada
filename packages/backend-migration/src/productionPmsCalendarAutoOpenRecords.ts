import { addPmsBlocker, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import { bool, integer, optionalDate, optionalText, uuid } from "./productionBookingValues.js";
import { outsideCohortSource } from "./productionMigrationCohort.js";
import { propertyClock } from "./productionPmsInventoryRecords.js";
import { pmsRecord } from "./productionPmsValues.js";

const SETTING_KEYS = ["enabled", "mode", "rollingMonths", "fixedEndMonth"] as const;

/**
 * VAY-1362: in a cohort run every resolved PMS hotel gets an explicit
 * pms.calendar_auto_open_settings row in the native settings writer's shape, because auto-open
 * is on by default (rolling 12) for a property without an explicit choice. A canonical cohort
 * hotel carries its legacy choice, enabled or disabled: the VAY-2066 producer keeps an enabled
 * window moving once the legacy scheduler is frozen, and a legacy "off" stays off. A hotel
 * outside the cohort or in private quarantine gets the row disabled, so it stays inert. A run
 * without a cohort plans nothing here, so its plan and checksum are unchanged.
 */
export function buildPmsCalendarAutoOpenRecords(context: PmsBuildContext): PmsTargetRecord[] {
  if (!context.cohort) return [];
  const records: PmsTargetRecord[] = [];
  for (const hotel of context.rowsByTable.get("hotels") ?? [])
    try {
      const hotelId = uuid(hotel.data["id"], "id");
      // An unresolved hotel is already a source-coverage blocker.
      const propertyId = context.propertyByHotel.get(hotelId);
      if (!propertyId) continue;
      const carried =
        !outsideCohortSource(context.cohort, "pms", hotelId) &&
        !context.target.propertyLinks.some(
          (link) =>
            link.sourceId.toLowerCase() === hotelId &&
            link.migrationDisposition === "private_quarantine",
        );
      records.push(settingRecord(context, hotel, hotelId, propertyId, carried));
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.hotels",
        safePmsSourceId(hotel),
        error instanceof Error ? error.message : "Invalid calendar auto-open setting",
      );
    }
  return records;
}

function settingRecord(
  context: PmsBuildContext,
  hotel: IdentitySourceRow,
  hotelId: string,
  propertyId: string,
  carried: boolean,
): PmsTargetRecord {
  const data = hotel.data;
  const enabled =
    bool(data["calendar_auto_open_enabled"], "calendar_auto_open_enabled", false) && carried;
  const mode =
    optionalText(data["calendar_auto_open_mode"], "calendar_auto_open_mode") ?? "rolling";
  const months = integer(data["calendar_auto_open_months"], "calendar_auto_open_months", 18);
  const fixedDate = optionalDate(
    data["calendar_auto_open_fixed_month"],
    "calendar_auto_open_fixed_month",
  );
  if (mode !== "rolling" && mode !== "fixed")
    throw new Error("calendar_auto_open_mode must be rolling or fixed");
  if (months !== 12 && months !== 18 && months !== 24)
    throw new Error("calendar_auto_open_months must be 12, 18 or 24");
  // Legacy ends a fixed window at the end of the month of any day in it; the target stores the
  // first of that month. A disabled fixed mode without a month cannot be stored, so it stays
  // rolling: either way the property opens nothing.
  const fixedEndMonth = mode === "fixed" && fixedDate ? `${fixedDate.slice(0, 7)}-01` : null;
  if (enabled && mode === "fixed") {
    if (!fixedEndMonth) throw new Error("enabled fixed calendar auto-open needs a target month");
    // The native writer and producer refuse a fixed month more than 24 months ahead.
    const [year, month] = propertyClock(context.snapshotAt, data["timezone"]).today.split("-");
    const last = Number(year) * 12 + Number(month) + 23;
    if (
      fixedEndMonth.slice(0, 7) >
      `${Math.floor(last / 12)}-${String((last % 12) + 1).padStart(2, "0")}`
    )
      throw new Error("fixed calendar auto-open month exceeds the native 24-month maximum");
  }
  const setting = fixedEndMonth
    ? { enabled, mode: "fixed", rollingMonths: null, fixedEndMonth }
    : { enabled, mode: "rolling", rollingMonths: months, fixedEndMonth: null };
  const existing = context.target.records.find(
    (record) =>
      record.targetTable === "calendar_auto_open_settings" && record.targetId === propertyId,
  );
  const same = SETTING_KEYS.every((key) => (existing?.row[key] ?? null) === setting[key]);
  // As the native writer: revision 1 on create and +1 per change. An unchanged setting keeps its
  // revision and time, so reruns and the post-write verification plan nothing.
  const migratedAt = new Date(context.completedAt).toISOString();
  return pmsRecord(
    hotel,
    "calendar_auto_open_settings",
    propertyId,
    migratedAt,
    true,
    {
      propertyId,
      revision: existing ? Number(existing.row["revision"]) + (same ? 0 : 1) : 1,
      ...setting,
      updatedAt: (existing && same && existing.updatedAt) || migratedAt,
    },
    // The open-through date and last run are window state the VAY-2066 producer recomputes, so
    // their daily moves neither map nor change the checksum.
    { id: hotelId, ...setting },
  );
}
