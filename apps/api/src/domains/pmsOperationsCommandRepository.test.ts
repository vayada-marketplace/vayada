import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPmsOperationsCommandRepository,
  type PmsOperationsCommandClient,
  type PmsOperationsCommandPool,
} from "./pmsOperationsCommandRepository.js";
import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import type {
  PmsCheckInCommand,
  PmsCommandMeta,
  PmsNoShowCommand,
  PmsOperationalReservation,
  PmsOperationalStatusCommand,
} from "../routes/pmsOperations.js";

const propertyId = "f6853000-0000-0000-0000-000000000001";
const guestBookingId = "f6854000-0000-0000-0000-000000000001";
const assignmentOneId = "f6855500-0000-0000-0000-000000000001";
const assignmentTwoId = "f6855500-0000-0000-0000-000000000002";
const userId = "f6851000-0000-0000-0000-000000000001";
const organizationId = "f6852000-0000-0000-0000-000000000001";

type RecordedQuery = {
  text: string;
  values: readonly unknown[];
};

type QueryHandler = (
  text: string,
  values: readonly unknown[],
) => Pick<QueryResult<QueryResultRow>, "rows" | "rowCount">;

class RecordingCommandClient implements PmsOperationsCommandClient {
  readonly calls: RecordedQuery[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
    this.calls.push({ text, values });
    const result = this.handler(text, values);
    return result as Pick<QueryResult<T>, "rows" | "rowCount">;
  }

  release(): void {}
}

function createRecordingPool(handler: QueryHandler): {
  client: RecordingCommandClient;
  pool: PmsOperationsCommandPool;
} {
  const client = new RecordingCommandClient(handler);
  return {
    client,
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

function ok(
  rows: QueryResultRow[] = [],
  rowCount = rows.length,
): Pick<QueryResult<QueryResultRow>, "rows" | "rowCount"> {
  return { rows, rowCount };
}

const baseReservation: PmsOperationalReservation = {
  guestBookingId,
  bookingReference: "BK-001",
  status: "assigned",
  source: "direct_booking",
  stay: { checkIn: "2026-08-15", checkOut: "2026-08-18", adults: 2, children: 0 },
  primaryGuest: { displayName: "Alex Guest", email: null, phone: null },
  assignments: [
    {
      assignmentId: assignmentOneId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      ratePlanId: null,
      roomId: "f6855100-0000-0000-0000-000000000001",
      roomNumber: "101",
      position: 1,
      assignmentStatus: "assigned",
      channel: "direct",
      assignedAt: "2026-08-14T16:00:00.000Z",
    },
    {
      assignmentId: assignmentTwoId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      ratePlanId: null,
      roomId: "f6855100-0000-0000-0000-000000000002",
      roomNumber: "102",
      position: 2,
      assignmentStatus: "assigned",
      channel: "direct",
      assignedAt: "2026-08-14T16:00:00.000Z",
    },
  ],
  checkin: { completedAt: null, pendingFlags: [] },
  checkout: { completedAt: null, pendingFlags: [] },
  privateNoteCount: 0,
  additionalGuestCount: 0,
};

const readRepository: PmsOperationsReadRepository = {
  async listRoomsByPropertyId() {
    return { items: [] };
  },
  async listRoomTypesByPropertyId() {
    return { items: [] };
  },
  async findRoomTypeById() {
    return null;
  },
  async listCalendarDaysByPropertyId() {
    return { items: [] };
  },
  async listRoomBlocksByPropertyId() {
    return { items: [] };
  },
  async listReservationsByPropertyId() {
    return { items: [], total: 0 };
  },
  async findReservationByGuestBookingId() {
    return structuredClone(baseReservation);
  },
};

function assignmentRows(status = "assigned"): QueryResultRow[] {
  return [
    {
      assignmentId: assignmentOneId,
      guestBookingId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      roomId: "f6855100-0000-0000-0000-000000000001",
      position: 1,
      assignmentStatus: status,
      version: "reservation-v7",
      updatedAt: "2026-08-14T16:00:00.000Z",
      checkIn: "2026-08-15",
      checkOut: "2026-08-18",
    },
    {
      assignmentId: assignmentTwoId,
      guestBookingId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      roomId: "f6855100-0000-0000-0000-000000000002",
      position: 2,
      assignmentStatus: status,
      version: "reservation-v7",
      updatedAt: "2026-08-14T16:00:00.000Z",
      checkIn: "2026-08-15",
      checkOut: "2026-08-18",
    },
  ];
}

function baseCheckInCommand(overrides: Partial<PmsCheckInCommand> = {}): PmsCheckInCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-checkin-001",
    idempotencyKey: "pms-checkin-001",
    expectedVersion: "reservation-v7",
    stepResults: [{ stepId: "passport", status: "completed" }],
    pendingFlags: ["deposit_review"],
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-checkin-001",
      correlationId: "corr-checkin-001",
      reason: "Check in guest",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function baseStatusCommand(
  overrides: Partial<PmsOperationalStatusCommand> = {},
): PmsOperationalStatusCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-status-001",
    idempotencyKey: "pms-status-001",
    expectedVersion: "reservation-v7",
    status: "in_house",
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-status-001",
      correlationId: "corr-status-001",
      reason: "Update PMS status",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function baseNoShowCommand(overrides: Partial<PmsNoShowCommand> = {}): PmsNoShowCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-no-show-001",
    idempotencyKey: "pms-no-show-001",
    expectedVersion: "reservation-v7",
    reason: "guest did not arrive",
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-no-show-001",
      correlationId: "corr-no-show-001",
      reason: "Mark reservation no-show",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function createRepository(handler: QueryHandler): {
  client: RecordingCommandClient;
  repository: ReturnType<typeof createTargetPmsOperationsCommandRepository>;
} {
  const { client, pool } = createRecordingPool(handler);
  return {
    client,
    repository: createTargetPmsOperationsCommandRepository({
      connectionString: "postgres://target",
      pool,
      readRepository,
      now: () => new Date("2026-08-15T15:45:00.000Z"),
    }),
  };
}

function successfulOperationalHandler(status = "assigned"): QueryHandler {
  return (text) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
    if (text.includes("FROM platform.idempotency_keys")) return ok();
    if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
    if (text.includes("FROM pms.operational_booking_assignments")) {
      return ok(assignmentRows(status));
    }
    if (text.includes("FROM pms.booking_checkin_records")) return ok();
    if (text.includes("INSERT INTO pms.booking_checkin_records")) return ok([], 2);
    if (text.includes("UPDATE pms.operational_booking_assignments")) return ok([], 2);
    if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
    if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
    throw new Error(`Unhandled SQL: ${text}`);
  };
}

describe("target PMS operations command repository", () => {
  it("writes property-scoped audit events and reservation-wide check-in mutations", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());

    const result = await repository.executeCheckInCommand(baseCheckInCommand());

    expect(result.ok).toBe(true);
    const checkInInsert = requiredCall(client, "INSERT INTO pms.booking_checkin_records");
    expect(checkInInsert.values[6]).toEqual([assignmentOneId, assignmentTwoId]);

    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[1]).toEqual([assignmentOneId, assignmentTwoId]);

    const auditInsert = requiredCall(client, "INSERT INTO platform.product_audit_events");
    expect(auditInsert.text).toContain("'property',\n       NULL,\n       $4::uuid");
    expect(auditInsert.values[3]).toBe(propertyId);
    expect(auditInsert.values).not.toContain(organizationId);
    expect(JSON.parse(String(auditInsert.values[11]))).toMatchObject({
      actorOrganizationId: organizationId,
      commandId: "cmd-checkin-001",
    });
  });

  it("rejects invalid explicit transition jumps before assignment update or audit", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());

    const result = await repository.executeOperationalStatusCommand(
      baseStatusCommand({ status: "checked_out" }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
    });
    expect(
      client.calls.some((call) => call.text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(false);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
  });

  it("keeps same-key check-in replay safe while rejecting new-key duplicate check-in", async () => {
    const replayCommand = baseCheckInCommand();
    const replayMeta: PmsCommandMeta = {
      contractVersion: "pms-operations.v1",
      commandId: replayCommand.commandId,
      idempotencyKey: replayCommand.idempotencyKey,
      acceptedAt: "2026-08-15T15:45:00.000Z",
      sideEffects: ["audit_event"],
    };
    const replayFingerprintHash = commandFingerprintHash(replayCommand);
    const replaySetup = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) {
        return ok([
          {
            status: "completed",
            requestFingerprintHash: replayFingerprintHash,
            idempotencyMetadata: { commandMeta: replayMeta },
          },
        ]);
      }
      throw new Error(`Replay should not mutate SQL: ${text}`);
    });

    const replayResult = await replaySetup.repository.executeCheckInCommand(replayCommand);

    expect(replayResult).toMatchObject({ ok: true, replayed: true, commandMeta: replayMeta });
    expect(
      replaySetup.client.calls.some((call) =>
        call.text.includes("INSERT INTO pms.booking_checkin_records"),
      ),
    ).toBe(false);

    const duplicateSetup = createRepository(successfulOperationalHandler("checked_in"));
    const duplicateResult = await duplicateSetup.repository.executeCheckInCommand(
      baseCheckInCommand({
        commandId: "cmd-checkin-duplicate",
        idempotencyKey: "pms-checkin-duplicate-001",
      }),
    );

    expect(duplicateResult).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
    });
    expect(
      duplicateSetup.client.calls.some((call) =>
        call.text.includes("INSERT INTO pms.booking_checkin_records"),
      ),
    ).toBe(false);
  });

  it("updates every assignment when no-show is reservation-wide", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());

    const result = await repository.executeNoShowCommand(baseNoShowCommand());

    expect(result.ok).toBe(true);
    const assignmentSelect = requiredCall(
      client,
      "FROM pms.operational_booking_assignments assignment",
    );
    expect(assignmentSelect.values[2]).toBeNull();
    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[0]).toEqual([assignmentOneId, assignmentTwoId]);
  });

  it("ignores malformed no-show assignmentId input instead of narrowing the reservation", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());
    const command = {
      ...baseNoShowCommand(),
      assignmentId: assignmentOneId,
    } as PmsNoShowCommand;

    const result = await repository.executeNoShowCommand(command);

    expect(result.ok).toBe(true);
    const assignmentSelect = requiredCall(
      client,
      "FROM pms.operational_booking_assignments assignment",
    );
    expect(assignmentSelect.values[2]).toBeNull();
    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[0]).toEqual([assignmentOneId, assignmentTwoId]);
  });
});

function requiredCall(client: RecordingCommandClient, sqlFragment: string): RecordedQuery {
  const call = client.calls.find((entry) => entry.text.includes(sqlFragment));
  if (!call) {
    throw new Error(`Expected SQL call containing ${sqlFragment}`);
  }
  return call;
}

function commandFingerprintHash(command: PmsCheckInCommand): string {
  const { audit: _audit, ...fingerprint } = command;
  return sha256(stableJson(fingerprint));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
