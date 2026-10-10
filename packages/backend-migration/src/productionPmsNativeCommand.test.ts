import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  nativeCommandId,
  nativeCommandRecords,
  type NativeCommand,
} from "./productionPmsNativeCommand.js";
import { PRODUCTION_PMS_TABLES, PRODUCTION_PMS_WRITE_ORDER } from "./productionPmsTables.js";

const RUN = "vay1351-0123456789abcdef01234567";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const AT = "2026-10-09T08:00:00.000Z";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const source: IdentitySourceRow = {
  sourceDatabase: "pms",
  sourceTable: "hotels",
  rowOrdinal: 1,
  data: { id: "10000000-0000-4000-a000-000000000001" },
};
const command = (name = "operating-calendar"): NativeCommand => ({
  source,
  propertyId: PROPERTY,
  name,
  at: AT,
  operation: "pms.operating_calendar.upsert",
  fingerprint: '{"request":1}',
  result: { b: 1, a: { d: 2, c: 3 } },
  replay: { resultJson: { ok: true } },
  eventType: "pms.operating_calendar.changed",
  resourceType: "operating_calendar",
  payload: { propertyId: PROPERTY },
  metadata: { contractVersion: "v1" },
  destination: "pms.inventory-source",
  eventKey: (key) => `event.${key}`,
  outboxKey: (key) => `outbox.${key}`,
  auditKey: (key) => `audit.${key}`,
  redactedPayload: { propertyId: PROPERTY },
  auditMetadata: { actorOrganizationId: "org" },
  checksumInput: { name },
});

describe("production PMS native command rows", () => {
  it("writes the four rows a native command writes, chained by their foreign keys", () => {
    const { ids, records } = nativeCommandRecords({ sourceRunId: RUN }, command());
    const row = (table: string) => records.find((record) => record.targetTable === table)!.row;
    const keyHash = sha256(`vay1362-migration:${RUN}:operating-calendar:${PROPERTY}`);
    expect(records.map((record) => record.targetTable)).toEqual([
      "idempotency_keys",
      "domain_events",
      "outbox_events",
      "product_audit_events",
    ]);
    expect(row("idempotency_keys")).toMatchObject({
      id: ids.idempotency,
      operationScope: "pms",
      keyHash,
      requestFingerprintHash: sha256('{"request":1}'),
      status: "completed",
      tenantScope: "property",
      organizationId: null,
      responseStatusCode: 200,
      // The native writers hash their stable JSON (keys in code-unit order).
      responseBodyHash: sha256('{"a":{"c":3,"d":2},"b":1}'),
      expiresAt: "2026-10-10T08:00:00.000Z",
      idempotencyMetadata: { attempt: 1, resultJson: { ok: true } },
    });
    expect(row("domain_events")).toMatchObject({
      id: ids.event,
      eventKey: `event.${keyHash}`,
      actorType: "migration",
      idempotencyKeyHash: keyHash,
      correlationId: `vay1362-migration:${RUN}`,
      causationId: RUN,
    });
    expect(row("outbox_events")).toMatchObject({
      id: ids.outbox,
      domainEventId: ids.event,
      outboxKey: `outbox.${keyHash}`,
      destination: "pms.inventory-source",
    });
    expect(row("product_audit_events")).toMatchObject({
      auditKey: `audit.${keyHash}`,
      action: "pms.operating_calendar.upsert",
      actorType: "migration",
      domainEventId: ids.event,
      idempotencyKeyId: ids.idempotency,
      auditMetadata: { migrationRunId: RUN, actorOrganizationId: "org" },
    });
  });

  it("plans the same rows on a rerun and separate rows per command and property", () => {
    const first = nativeCommandRecords({ sourceRunId: RUN }, command());
    expect(nativeCommandRecords({ sourceRunId: RUN }, command())).toEqual(first);
    expect(first.ids.idempotency).toBe(
      nativeCommandId("operating-calendar", "idempotency", PROPERTY),
    );
    const other = nativeCommandRecords({ sourceRunId: RUN }, command("inventory-materialization"));
    expect(Object.values(other.ids)).not.toContain(first.ids.idempotency);
  });

  it("writes the platform rows before the setup rows that reference them", () => {
    const order = (table: string) => PRODUCTION_PMS_WRITE_ORDER.indexOf(table as never);
    for (const table of ["idempotency_keys", "domain_events", "outbox_events"])
      expect(order(table)).toBeLessThan(order("operating_calendar_revisions"));
    expect(order("operating_calendar_revisions")).toBeLessThan(
      order("operating_calendar_recurring_periods"),
    );
    expect(order("operating_calendar_recurring_periods")).toBeLessThan(
      order("operating_calendar_room_bindings"),
    );
    for (const table of [
      "idempotency_keys",
      "domain_events",
      "outbox_events",
      "operating_calendar_revisions",
      "operating_calendar_recurring_periods",
      "operating_calendar_room_bindings",
    ])
      expect(PRODUCTION_PMS_TABLES[table]).toBeDefined();
  });
});
