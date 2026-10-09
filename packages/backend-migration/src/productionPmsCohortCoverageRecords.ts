import {
  PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
  PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY,
  PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
} from "@vayada/domain-pms";

import type { HorizonedCohortCalendar } from "./productionPmsInventoryRecords.js";
import { nativeCommandRecords, nativeStableJson } from "./productionPmsNativeCommand.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import { pmsRecord } from "./productionPmsValues.js";

const EVENT_TYPE = "pms.inventory.projection_refresh_requested";

/**
 * VAY-1362: the coverage a native first materialization records for the calendar
 * (pmsInventoryMaterializationRepository: full-horizon apply at calendar revision 1), with its
 * idempotency key, projection-refresh domain event and distribution.inventory-projection outbox
 * row (the coverage's foreign keys) and its audit row. The inventory rows themselves are planned
 * canonically by buildPmsInventoryRecords over the same horizon.
 * Not reproduced: the per-room pms.channel-manager ARI outbox rows (ARI stays observe-only until
 * the go-day ARI diff; the first auto-open job enqueues its own) and the linked-inventory
 * reconcile side effects (migrated linked stop-sell state is carried on the rows).
 */
export function buildPmsCohortCoverageRecords(
  context: PmsBuildContext,
  calendars: HorizonedCohortCalendar[],
): PmsTargetRecord[] {
  return calendars.flatMap((calendar) => {
    const { configuration, organizationId, hotel } = calendar;
    const { propertyId, createdAt: at, source: configurationSource } = configuration;
    const horizon = { from: calendar.horizon.from, through: calendar.horizon.through };
    const roomTypeIds = configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId);
    const days = (Date.parse(horizon.through) - Date.parse(horizon.from)) / 86_400_000 + 1;
    const dayCount = roomTypeIds.length * days;
    const coverage = {
      configurationSource,
      materializedRevision: 1,
      coverageFrom: horizon.from,
      coverageThrough: horizon.through,
      roomTypeIds,
      expectedDayCount: dayCount,
      materializedDayCount: dayCount,
      gaps: [],
    };
    const intent = {
      contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
      destination: PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
      eventType: EVENT_TYPE,
      organizationId,
      propertyId,
      configurationSource,
      materializedRevision: 1,
      coverageFrom: horizon.from,
      coverageThrough: horizon.through,
      roomTypeIds,
      reason: "full_horizon_apply",
    };
    const result = {
      ok: true,
      outcome: "applied",
      coverage,
      changedDayCount: dayCount,
      projectionRefreshIntent: intent,
    };
    const request = {
      organizationId,
      propertyId,
      configurationSource,
      expectedMaterializedRevision: 1,
      horizon,
    };
    const metadata = {
      contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
      sourceReadRequired: true,
    };
    const checksumInput = { configuration, organizationId, horizon };
    const command = nativeCommandRecords(context, {
      source: hotel,
      propertyId,
      name: "inventory-materialization",
      at,
      operation: PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY.operation,
      fingerprint: nativeStableJson(request),
      result,
      replay: { result },
      eventType: EVENT_TYPE,
      resourceType: "inventory_materialization",
      payload: intent,
      metadata,
      destination: PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
      eventKey: (key) =>
        `pms.inventory.projection-refresh.property.${propertyId}.key.${key}.attempt.1.v1`,
      outboxKey: (key) =>
        `${PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION}.property.${propertyId}.key.${key}.attempt.1.v1`,
      auditKey: (key) =>
        `pms.inventory-materialization.property.${propertyId}.key.${key}.attempt.1.v1`,
      redactedPayload: { ...request, outcome: "applied", changedDayCount: dayCount, coverage },
      auditMetadata: {
        actorOrganizationId: organizationId,
        contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
      },
      checksumInput,
    });
    return [
      ...command.records,
      pmsRecord(
        hotel,
        "inventory_materialization_coverage",
        propertyId,
        at,
        true,
        {
          propertyId,
          organizationId,
          calendarRevision: 1,
          materializedRevision: 1,
          coverageFrom: horizon.from,
          coverageThrough: horizon.through,
          roomTypeCount: roomTypeIds.length,
          expectedDayCount: dayCount,
          materializedDayCount: dayCount,
          lastChangedMaterializationIdempotencyKeyId: command.ids.idempotency,
          lastChangedMaterializationDomainEventId: command.ids.event,
          lastChangedMaterializationOutboxEventId: command.ids.outbox,
          updatedAt: at,
        },
        checksumInput,
      ),
    ];
  });
}
