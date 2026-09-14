import { z } from "zod";
import type { ExternalRevenueEvidenceLine } from "./bookingExternalNightlyRevenueEvidence.js";

const date = z.iso.date().refine((value) => !value.startsWith("0000-"));
const night = z
  .object({
    roomTypeId: z.uuid(),
    stayDate: date,
    linePosition: z.number().int().min(1).max(1000),
    grossRoomAmount: z
      .string()
      .regex(/^\d{1,15}(?:\.\d{1,4})?$/)
      .nullable(),
    evidenceQuality: z.enum(["exact", "inferred", "missing"]),
  })
  .refine((line) => (line.grossRoomAmount === null) === (line.evidenceQuality === "missing"));
const currentNight = night.safeExtend({
  evidenceId: z.uuid(),
  recognizedOn: date,
  occupiedRoomNights: z.union([z.literal(0), z.literal(1)]),
});
export type OtaRevenueNight = z.infer<typeof night>;
export type CurrentOtaRevenueNight = z.infer<typeof currentNight>;

/** Caller supplies scoped, locked ledger aggregates/current tips and verified gross economics. */
export function planOtaRevenueCorrections(
  current: readonly CurrentOtaRevenueNight[],
  desired: readonly OtaRevenueNight[],
  accountingDate: string,
): ExternalRevenueEvidenceLine[] {
  const fail = () => {
    throw new Error("alteration_revenue_correction_unsupported");
  };
  const oldResult = z.array(currentNight).max(1000).safeParse(current);
  const nextResult = z.array(night).min(1).max(1000).safeParse(desired);
  if (!oldResult.success || !nextResult.success || !date.safeParse(accountingDate).success)
    return fail();
  const key = (line: OtaRevenueNight) => `${line.linePosition}:${line.stayDate}`;
  const old = new Map(oldResult.data.map((line) => [key(line), line]));
  const next = new Map(nextResult.data.map((line) => [key(line), line]));
  if (old.size !== current.length || next.size !== desired.length) return fail();
  const result: ExternalRevenueEvidenceLine[] = [];
  for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const before = old.get(id),
      after = next.get(id);
    if (!before) {
      result.push({
        ...after!,
        recognizedOn: after!.stayDate,
        occupiedRoomNights: 1,
        economicEvent: "room_night",
        lifecycleState: "confirmed",
      });
      continue;
    }
    const recognizedOn = [accountingDate, before.recognizedOn, before.stayDate].sort().at(-1)!;
    if (after && before.roomTypeId !== after.roomTypeId) return fail();
    const original = before.grossRoomAmount === null ? null : units(before.grossRoomAmount);
    if (before.occupiedRoomNights === 0 && original !== null && original !== 0n) return fail();
    const base = {
      roomTypeId: before.roomTypeId,
      stayDate: before.stayDate,
      linePosition: before.linePosition,
      recognizedOn,
      correctsEvidenceId: before.evidenceId,
      lifecycleState: "corrected" as const,
    };
    if (!after) {
      if (before.occupiedRoomNights === 1)
        result.push({
          ...base,
          grossRoomAmount: original === null ? null : decimal(-original),
          evidenceQuality: before.evidenceQuality,
          occupiedRoomNights: -1,
          economicEvent: "occupancy_adjustment",
        });
      continue;
    }
    if (before.occupiedRoomNights === 0) {
      if (original !== null && after.grossRoomAmount === null) return fail();
      result.push({
        ...base,
        grossRoomAmount: after.grossRoomAmount,
        evidenceQuality: after.evidenceQuality,
        occupiedRoomNights: 1,
        economicEvent: "occupancy_adjustment",
      });
      continue;
    }
    const replacement = after.grossRoomAmount === null ? null : units(after.grossRoomAmount);
    if (original === replacement && before.evidenceQuality === after.evidenceQuality) continue;
    // The ledger cannot represent losing known money or changing quality with a zero known-money delta.
    if (replacement === null || (original !== null && original === replacement)) return fail();
    result.push({
      ...base,
      grossRoomAmount: decimal(replacement - (original ?? 0n)),
      evidenceQuality: after.evidenceQuality,
      occupiedRoomNights: 0,
      economicEvent: "correction",
    });
  }
  if (result.length > 1000) return fail();
  return result;
}

function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, "0"));
}
function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, "0")}`;
}
