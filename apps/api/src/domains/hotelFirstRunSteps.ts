import { createHash } from "node:crypto";

import {
  FIRST_RUN_DEFAULT_BED,
  FIRST_RUN_DEFAULTS_VERSION,
  firstRunRoomFacts,
  firstRunRoomLabels,
  type FirstRunBedChoice,
  type FirstRunRoomInput,
} from "@vayada/domain-booking";
import {
  parseReplaceFinancePaymentMethodsCommand,
  type FinancePaymentMethodsCommandPort,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import {
  parseCreateRoomTypeFactsCommand,
  parseDraftRoomId,
  parseReconcilePhysicalRoomUnitsCommand,
  parseSetPhysicalRoomOperationalLabelCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  type DraftRoomTypeBindingReadPort,
  type PhysicalRoomOperationalLabelPort,
  type PhysicalRoomUnitIdentityReadPort,
  type PhysicalRoomUnitReconcilePort,
  type PmsPricingCommandPort,
  type PmsPricingReadPort,
  type RoomCapacityReadPort,
  type RoomFactsCommandPort,
  type RoomFactsReadPort,
} from "@vayada/domain-pms";
import { defaultCurrencyForCountry } from "@vayada/locale-constants";

/**
 * VAY-2247 first run, steps 1–3: currency → rooms → payments. Each step reads first, writes only what is
 * missing and never overwrites what the owner set. Keys are derived from the property, the step and its
 * input, so a retry or a resume after a crash replays the same command instead of writing twice.
 */

export type HotelFirstRunActor = Readonly<{
  organizationId: string;
  propertyId: string;
  userId: string;
  requestId: string;
  correlationId: string | null;
  requestedAt: string;
}>;

/** The fixed setup-draft id of the first run's room type at `index`, so a resume finds each again. */
export function firstRunDraftRoomId(index: number): string {
  return `first-run-room-${index + 1}`;
}

/** The first room type's draft id (the first run made only this one before VAY-2247 1.12). */
export const FIRST_RUN_DRAFT_ROOM_ID = firstRunDraftRoomId(0);

/** A first run creates up to this many room types; the rest are added later in Rooms & Rates. */
export const FIRST_RUN_MAX_ROOM_TYPES = 10;

export type HotelFirstRunStepOutcome =
  | Readonly<{ ok: true; wrote: boolean }>
  | Readonly<{ ok: false; code: string; cause?: unknown }>;

export type HotelFirstRunSetupPorts = Readonly<{
  pricingRead: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  currency: Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency">;
  roomRead: Pick<RoomFactsReadPort, "listRoomTypeFacts"> &
    DraftRoomTypeBindingReadPort &
    RoomCapacityReadPort &
    PhysicalRoomUnitIdentityReadPort;
  roomFacts: Pick<RoomFactsCommandPort, "createRoomTypeFacts">;
  units: PhysicalRoomUnitReconcilePort;
  labels: PhysicalRoomOperationalLabelPort;
  paymentRead: FinancePaymentReadinessReadPort;
  payments: FinancePaymentMethodsCommandPort;
}>;

/** `first-run:v1:<step>:<sha256>`: the same property, step and input always give the same key (≤ 200 chars). */
export function firstRunIdempotencyKey(propertyId: string, step: string, input: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([FIRST_RUN_DEFAULTS_VERSION, propertyId, step, input]))
    .digest("hex");
  return `first-run:v1:${step}:${digest}`;
}

function audit(actor: HotelFirstRunActor) {
  return {
    actor: { kind: "user" as const, userId: actor.userId },
    requestId: actor.requestId,
    correlationId: actor.correlationId,
    requestedAt: actor.requestedAt,
  };
}

const fail = (code: string, cause?: unknown) => Object.freeze({ ok: false as const, code, cause });
const ok = (wrote: boolean): HotelFirstRunStepOutcome => Object.freeze({ ok: true, wrote });

/** Step 1: the hotel's currency from its country, unless it already has one. */
export async function runFirstRunCurrency(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
  countryCode: string | null,
): Promise<HotelFirstRunStepOutcome> {
  if (await ports.pricingRead.getPropertyPricingCurrency(actor.propertyId)) return ok(false);
  const currency = defaultCurrencyForCountry(countryCode);
  const command = parseUpsertPropertyPricingCurrencyCommand({
    organizationId: actor.organizationId,
    propertyId: actor.propertyId,
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "currency", currency),
    audit: audit(actor),
    expectedPricingCurrencyRevision: 0,
    currency,
  });
  if (!command) return fail("first_run_currency_invalid");
  const result = await ports.currency.upsertPropertyPricingCurrency(command);
  return result.ok ? ok(true) : fail("first_run_currency_failed", result.error);
}

/**
 * Step 2: the room types in order, their rooms and the rooms' names. Skipped when the owner already has room
 * types of their own; resumes a half-done first run (a room type created, its rooms missing or not yet
 * named). Room names are unique in a hotel, so they count on across room types: Room 1–8, then Room 9–12.
 * Every room type gets the owner's bed choice (1.12b); a room type already made keeps its beds.
 */
export async function runFirstRunRooms(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
  rooms: readonly FirstRunRoomInput[],
  bed: FirstRunBedChoice = FIRST_RUN_DEFAULT_BED,
): Promise<HotelFirstRunStepOutcome> {
  const ids = await Promise.all(
    rooms.map(async (_room, index) => {
      const draftRoomId = parseDraftRoomId(firstRunDraftRoomId(index))!;
      return (
        (await ports.roomRead.getDraftRoomTypeBinding(actor.propertyId, draftRoomId))?.roomTypeId ??
        null
      );
    }),
  );
  if (
    ids.every((id) => id === null) &&
    (await ports.roomRead.listRoomTypeFacts(actor.propertyId)).length > 0
  )
    return ok(false);
  let wrote = false;
  let nextNumber = 1;
  for (const [index, room] of rooms.entries()) {
    const outcome = await runFirstRunRoomType(
      ports,
      actor,
      index,
      room,
      ids[index] ?? null,
      nextNumber,
      bed,
    );
    if (!outcome.ok) return outcome;
    wrote ||= outcome.wrote;
    nextNumber = outcome.nextNumber;
  }
  return ok(wrote);
}

const ROOM_NUMBER = /^Room (\d+)$/;

async function runFirstRunRoomType(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
  index: number,
  room: FirstRunRoomInput,
  existingRoomTypeId: string | null,
  nextNumber: number,
  bed: FirstRunBedChoice,
): Promise<Readonly<{ ok: true; wrote: boolean; nextNumber: number }> | ReturnType<typeof fail>> {
  const { propertyId } = actor;
  let wrote = false;
  let roomTypeId = existingRoomTypeId;
  if (!roomTypeId) {
    const facts = firstRunRoomFacts(room, bed);
    if (!facts) return fail("first_run_room_invalid");
    const command = parseCreateRoomTypeFactsCommand({
      organizationId: actor.organizationId,
      propertyId,
      // The first room type keeps the key it had when the first run made only one.
      idempotencyKey: firstRunIdempotencyKey(
        propertyId,
        "room_type",
        index === 0 ? facts : [index, facts],
      ),
      audit: audit(actor),
      draftRoomId: parseDraftRoomId(firstRunDraftRoomId(index))!,
      expectedRevision: 0,
      facts,
    });
    if (!command) return fail("first_run_room_invalid");
    const created = await ports.roomFacts.createRoomTypeFacts(command);
    if (!created.ok) return fail("first_run_room_failed", created.error);
    roomTypeId = created.response.roomType.roomTypeId;
    wrote = true;
  }

  const capacity = await ports.roomRead.getRoomTypeCapacity(propertyId, roomTypeId);
  if (!capacity) return fail("first_run_room_capacity_missing");
  let unitsRevision = capacity.roomUnitsRevision;
  if (capacity.activeUnitCount === 0) {
    const command = parseReconcilePhysicalRoomUnitsCommand({
      organizationId: actor.organizationId,
      propertyId,
      roomTypeId,
      expectedRevision: unitsRevision,
      targetActiveUnitCount: room.numberOfRooms,
      idempotencyKey: firstRunIdempotencyKey(propertyId, "room_units", [
        roomTypeId,
        room.numberOfRooms,
      ]),
      audit: audit(actor),
    });
    if (!command) return fail("first_run_room_units_invalid");
    const reconciled = await ports.units.reconcilePhysicalRoomUnits(command);
    if (!reconciled.ok) return fail("first_run_room_units_failed", reconciled.error);
    unitsRevision = reconciled.response.capacity.roomUnitsRevision;
    wrote = true;
  }

  // Name every unnamed room "Room N", after the numbers this and the earlier room types already use.
  const units = (
    await ports.roomRead.listPhysicalRoomUnitIdentities(propertyId, roomTypeId)
  ).filter((unit) => unit.lifecycle === "active");
  const unnamed = units.filter((unit) => unit.operationalLabelStatus !== "verified");
  const first = units.reduce((next, unit) => {
    const number =
      unit.operationalLabelStatus === "verified"
        ? Number(ROOM_NUMBER.exec(unit.operationalLabel)?.[1] ?? 0)
        : 0;
    return Math.max(next, number + 1);
  }, nextNumber);
  const labels = unnamed.length ? firstRunRoomLabels(unnamed.length, first) : [];
  for (const [unitIndex, unit] of unnamed.entries()) {
    const command = parseSetPhysicalRoomOperationalLabelCommand({
      organizationId: actor.organizationId,
      propertyId,
      roomTypeId,
      roomUnitId: unit.roomUnitId,
      expectedRevision: unitsRevision,
      operationalLabel: labels[unitIndex],
      idempotencyKey: firstRunIdempotencyKey(propertyId, "room_label", [
        unit.roomUnitId,
        labels[unitIndex],
      ]),
      audit: audit(actor),
    });
    if (!command) return fail("first_run_room_label_invalid");
    const named = await ports.labels.setPhysicalRoomOperationalLabel(command);
    if (!named.ok) return fail("first_run_room_label_failed", named.error);
    unitsRevision = named.response.roomUnitsRevision;
    wrote = true;
  }
  return Object.freeze({ ok: true, wrote, nextNumber: first + unnamed.length });
}

/** Step 3: pay at the property, unless payment methods are already chosen for the current currency. */
export async function runFirstRunPayments(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
): Promise<HotelFirstRunStepOutcome> {
  const scope = { organizationId: actor.organizationId, propertyId: actor.propertyId };
  const readiness = await ports.paymentRead.getPaymentReadiness(scope);
  const current =
    readiness?.pricingCurrency.current ?? (await currentCurrency(ports, actor.propertyId));
  if (!current) return fail("first_run_payments_currency_missing");
  const selected =
    readiness?.methods.filter((method) => method.selected).map((method) => method.method) ?? [];
  if (selected.includes("pay_at_property") && readiness?.pricingCurrency.matchesCurrent)
    return ok(false);
  // Keep any method the owner already chose; add pay at the property.
  const selectedMethods = [...new Set([...selected, "pay_at_property"])];
  const command = parseReplaceFinancePaymentMethodsCommand({
    ...scope,
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "payments", [
      readiness?.paymentMethodsRevision ?? 0,
      current.pricingCurrencyRevision,
      selectedMethods,
    ]),
    expectedPaymentMethodsRevision: readiness?.paymentMethodsRevision ?? 0,
    expectedPricingCurrencyRevision: current.pricingCurrencyRevision,
    selectedMethods,
    audit: audit(actor),
  });
  if (!command) return fail("first_run_payments_invalid");
  const result = await ports.payments.replacePaymentMethods(command);
  return result.ok ? ok(true) : fail("first_run_payments_failed", result.error);
}

async function currentCurrency(ports: HotelFirstRunSetupPorts, propertyId: string) {
  const snapshot = await ports.pricingRead.getPropertyPricingCurrency(propertyId);
  return snapshot ? { pricingCurrencyRevision: snapshot.pricingCurrencyRevision } : null;
}
