import { createHash } from "node:crypto";

import {
  FIRST_RUN_DEFAULTS_VERSION,
  firstRunRoomFacts,
  firstRunRoomLabels,
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

/** The fixed setup-draft id of the room type the first run creates, so a resume finds it again. */
export const FIRST_RUN_DRAFT_ROOM_ID = "first-run-room-1";

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

const fail = (code: string, cause?: unknown): HotelFirstRunStepOutcome =>
  Object.freeze({ ok: false, code, cause });
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
 * Step 2: the first room type, its rooms and their names. Skipped when the owner already has room types of
 * their own; resumes a half-done first run (room type created, rooms missing or not yet named).
 */
export async function runFirstRunRooms(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
  room: FirstRunRoomInput,
): Promise<HotelFirstRunStepOutcome> {
  const { propertyId } = actor;
  const draftRoomId = parseDraftRoomId(FIRST_RUN_DRAFT_ROOM_ID)!;
  const binding = await ports.roomRead.getDraftRoomTypeBinding(propertyId, draftRoomId);
  let wrote = false;
  let roomTypeId = binding?.roomTypeId ?? null;
  if (!roomTypeId) {
    if ((await ports.roomRead.listRoomTypeFacts(propertyId)).length > 0) return ok(false);
    const facts = firstRunRoomFacts(room);
    if (!facts) return fail("first_run_room_invalid");
    const command = parseCreateRoomTypeFactsCommand({
      organizationId: actor.organizationId,
      propertyId,
      idempotencyKey: firstRunIdempotencyKey(propertyId, "room_type", facts),
      audit: audit(actor),
      draftRoomId,
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

  // Name every unnamed room "Room N", continuing after the rooms that already have a name.
  const units = (
    await ports.roomRead.listPhysicalRoomUnitIdentities(propertyId, roomTypeId)
  ).filter((unit) => unit.lifecycle === "active");
  const unnamed = units.filter((unit) => unit.operationalLabelStatus !== "verified");
  const labels = unnamed.length
    ? firstRunRoomLabels(unnamed.length, units.length - unnamed.length + 1)
    : [];
  for (const [index, unit] of unnamed.entries()) {
    const command = parseSetPhysicalRoomOperationalLabelCommand({
      organizationId: actor.organizationId,
      propertyId,
      roomTypeId,
      roomUnitId: unit.roomUnitId,
      expectedRevision: unitsRevision,
      operationalLabel: labels[index],
      idempotencyKey: firstRunIdempotencyKey(propertyId, "room_label", [
        unit.roomUnitId,
        labels[index],
      ]),
      audit: audit(actor),
    });
    if (!command) return fail("first_run_room_label_invalid");
    const named = await ports.labels.setPhysicalRoomOperationalLabel(command);
    if (!named.ok) return fail("first_run_room_label_failed", named.error);
    unitsRevision = named.response.roomUnitsRevision;
    wrote = true;
  }
  return ok(wrote);
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
