import { createPgPmsRoomFactsCommandRepository } from "./pmsRoomFactsCommandRepository.js";
import { createPmsRoomFactsVocabularyValidationPort } from "./pmsRoomFactsVocabulary.js";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Pool } from "pg";
import {
  parseUpdateRoomTypeFactsCommand,
  parsePreviewPmsOperatingCalendarImpactCommand,
  parseUpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import { createPgPmsPhysicalRoomUnitReconcileRepository } from "./pmsPhysicalRoomUnitReconcileRepository.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { createPmsOperatingCalendarProductionRuntime } from "./pmsOperatingCalendarProductionRuntime.js";

/** Test identity only; all room units, calendar and inventory use their owned commands. */
export async function prepareStagingReadiness(
  db: Pool,
  connectionString: string,
  propertyId: string,
  roomTypeId: string,
) {
  const organizationId = randomUUID(),
    userId = randomUUID();
  await db.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Bootstrap operator')", [
    userId,
    `${userId}@example.test`,
  ]);
  await db.query(
    "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Bootstrap',$1::text)",
    [organizationId],
  );
  await db.query(
    "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin) VALUES($1,$2,'owner','agency')",
    [organizationId, userId],
  );
  await db.query(
    "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship) VALUES($1,'pms','pms_property',$2,'owner')",
    [organizationId, propertyId],
  );
  await db.query(
    "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','property-management','active')",
    [organizationId],
  );
  await db.query(
    "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/London')",
    [propertyId],
  );
  const audit = {
    actor: { kind: "user" as const, userId },
    requestId: randomUUID(),
    correlationId: null,
    requestedAt: new Date().toISOString(),
  };
  const roomFacts = createPgPmsRoomFactsCommandRepository({
    connectionString,
    vocabularyValidator: createPmsRoomFactsVocabularyValidationPort(),
  });
  const units = createPgPmsPhysicalRoomUnitReconcileRepository({ connectionString });
  const profile = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString,
  });
  const facts = createPgPmsRoomFactsReadModel({ connectionString });
  const roomEvidence = { roomFacts: facts, roomCapacity: facts };
  const calendar = createPgPmsOperatingCalendarReadModel({
    connectionString,
    propertyProfileEvidence: profile,
    roomEvidence,
  });
  const runtime = createPmsOperatingCalendarProductionRuntime({
    enabled: true,
    connectionString,
    confirmationSecret: "synthetic-bootstrap-calendar-secret-32-bytes",
    authorizationPool: db,
    propertyProfileEvidence: profile,
    roomEvidence,
    operatingCalendar: calendar,
  })!;
  try {
    const factsCommand = parseUpdateRoomTypeFactsCommand({
      organizationId,
      propertyId,
      roomTypeId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      audit,
      facts: {
        name: "Synthetic Double",
        description: "",
        category: null,
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        beds: [{ type: "double", quantity: 1 }],
        bedrooms: null,
        bathrooms: null,
        bathroomType: "private",
        size: null,
      },
    })!;
    expect(await roomFacts.updateRoomTypeFacts(factsCommand)).toMatchObject({ ok: true });
    const unitCommand = {
      organizationId,
      propertyId,
      roomTypeId,
      expectedRevision: 1,
      targetActiveUnitCount: 1,
      idempotencyKey: randomUUID(),
      audit,
    };
    expect(await units.reconcilePhysicalRoomUnits(unitCommand)).toMatchObject({ ok: true });
    expect(await units.reconcilePhysicalRoomUnits(unitCommand)).toMatchObject({ ok: true });
    const proposal = parsePreviewPmsOperatingCalendarImpactCommand({
      organizationId,
      propertyId,
      expectedCalendarRevision: 0,
      expectedPropertyProfileRevision: 1,
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
      roomTypeLimits: [
        {
          roomTypeId,
          expectedRoomFactsRevision: 2,
          expectedRoomUnitsRevision: 2,
          startingSellableLimitCount: 1,
        },
      ],
      audit,
    })!;
    const preview =
      await runtime.routes.impactPreviewPort!.previewOperatingCalendarImpact(proposal);
    expect(preview).toMatchObject({ ok: true });
    if (!preview.ok) throw new Error("Calendar preview failed");
    const command = parseUpsertPmsOperatingCalendarCommand({
      ...proposal,
      impactConfirmation: preview.preview.confirmation,
      idempotencyKey: randomUUID(),
    })!;
    const applied = await runtime.routes.commandPort!.upsertOperatingCalendar(command);
    expect(applied).toMatchObject({ ok: true });
    if (!applied.ok) throw new Error("Calendar apply failed");
    const materialize = {
      organizationId,
      propertyId,
      configurationSource: applied.response.configuration.source,
      expectedMaterializedRevision: 1,
      horizon: { from: "2026-09-14", through: "2026-09-14" },
      idempotencyKey: randomUUID(),
      audit,
    };
    expect(await runtime.inventory.materializeInventory(materialize)).toMatchObject({ ok: true });
    expect(await runtime.inventory.materializeInventory(materialize)).toMatchObject({ ok: true });
  } finally {
    await Promise.all([
      roomFacts.close(),
      units.close(),
      runtime.close(),
      calendar.close(),
      facts.close(),
      profile.close(),
    ]);
  }
}
