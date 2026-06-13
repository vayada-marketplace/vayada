import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPmsOperationsCommandRepository,
  type PmsOperationsCommandPool,
} from "./domains/pmsOperationsCommandRepository.js";
import type {
  PmsOperationalTemplate,
  PmsOperationalTemplateUpdateCommand,
  PmsOperationsReadRepository,
  PmsPrivateNote,
  PmsPrivateNoteCreateCommand,
} from "./routes/pmsOperations.js";

describe("PMS operations command repository", () => {
  it("replays a private-note create from idempotency metadata after the note is hard-deleted", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });
    const createCommand = privateNoteCreateCommand({
      idempotencyKey: "client-private-note-create-replay",
    });

    const created = await repository.createPrivateNote(createCommand);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("private note create unexpectedly failed");

    const deleted = await repository.deletePrivateNote({
      propertyId: createCommand.propertyId,
      guestBookingId: createCommand.guestBookingId,
      noteId: created.note.noteId,
      actorUserId: createCommand.actorUserId,
      commandId: "cmd-private-note-delete-replay-test",
      idempotencyKey: "client-private-note-delete-replay-test",
    });
    expect(deleted.ok).toBe(true);
    expect(target.notes).toHaveLength(0);

    const replay = await repository.createPrivateNote(createCommand);

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("private note create replay unexpectedly failed");
    expect(replay.note).toEqual(created.note);
    expect(replay.commandMeta).toEqual(created.commandMeta);
    expect(target.notes).toHaveLength(0);
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.booking_notes_private")),
    ).toHaveLength(1);
    expect(
      target.auditEvents.filter((event) => event.action === "pms.private_note.created"),
    ).toHaveLength(1);
    expect(target.auditEvents).toHaveLength(2);
  });

  it("scopes private-note audit keys by property and note when client idempotency keys are reused", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });
    const idempotencyKey = "client-reused-private-note-key";
    const otherPropertyId = "f6853000-0000-0000-0000-000000000002";

    const first = await repository.createPrivateNote(privateNoteCreateCommand({ idempotencyKey }));
    const second = await repository.createPrivateNote(
      privateNoteCreateCommand({
        propertyId: otherPropertyId,
        guestBookingId: "f6854000-0000-0000-0000-000000000002",
        commandId: "cmd-private-note-create-other-property",
        idempotencyKey,
      }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(target.auditEvents).toHaveLength(2);
    expect(target.auditEvents.map((event) => event.auditKey)).toEqual([
      expect.stringContaining(`property.${defaultPropertyId}.note.`),
      expect.stringContaining(`property.${otherPropertyId}.note.`),
    ]);
    expect(new Set(target.auditEvents.map((event) => event.auditKey)).size).toBe(2);
    for (const event of target.auditEvents) {
      expect(event.auditKey).toContain(`key.${sha256(idempotencyKey)}.v1`);
      expect(event.auditKey).not.toBe(`pms.private_note.created.${idempotencyKey}.v1`);
    }
  });

  it("reads and upserts PMS operational templates into the owned template tables", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });

    const emptyChecklist = await repository.getOperationalTemplate(
      defaultPropertyId,
      "check_in_checklist",
    );
    expect(emptyChecklist).toMatchObject({
      propertyId: defaultPropertyId,
      templateKind: "check_in_checklist",
      steps: [],
      updatedAt: null,
    });

    const checklist = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_in_checklist"),
    );
    const inspection = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_out_inspection", {
        commandId: "cmd-inspection-template",
        idempotencyKey: "client-inspection-template",
      }),
    );

    expect(checklist.ok).toBe(true);
    expect(inspection.ok).toBe(true);
    if (!checklist.ok || !inspection.ok) {
      throw new Error("template update unexpectedly failed");
    }
    expect(checklist.template).toMatchObject({
      propertyId: defaultPropertyId,
      templateKind: "check_in_checklist",
      steps: [{ stepId: "passport", label: "Verify passport", required: true }],
      updatedByUserId: "f6851000-0000-0000-0000-000000000001",
    });
    expect(inspection.template.templateKind).toBe("check_out_inspection");

    const replayedRead = await repository.getOperationalTemplate(
      defaultPropertyId,
      "check_in_checklist",
    );
    const replayedWrite = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_in_checklist"),
    );
    const conflictingWrite = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_in_checklist", {
        steps: [{ stepId: "deposit", label: "Review deposit", required: false }],
      }),
    );

    expect(replayedRead.steps).toEqual(checklist.template.steps);
    expect(replayedWrite).toEqual(checklist);
    expect(conflictingWrite).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
    });
    expect(target.calls.some((call) => call.text.includes("pms.checkin_checklist_templates"))).toBe(
      true,
    );
    expect(
      target.calls.some((call) => call.text.includes("pms.checkout_inspection_templates")),
    ).toBe(true);
    expect(target.auditEvents.map((event) => event.action)).toEqual([
      "pms.check_in_checklist.updated",
      "pms.check_out_inspection.updated",
    ]);
    expect(
      target.calls.filter((call) =>
        call.text.includes("INSERT INTO pms.checkin_checklist_templates"),
      ),
    ).toHaveLength(1);
  });
});

const defaultPropertyId = "f6853000-0000-0000-0000-000000000001";
const defaultGuestBookingId = "f6854000-0000-0000-0000-000000000001";

type QueryCall = {
  text: string;
  values?: readonly unknown[];
};

type PrivateNoteRecord = {
  propertyId: string;
  guestBookingId: string;
  note: PmsPrivateNote;
};

type TemplateRecord = {
  propertyId: string;
  template: PmsOperationalTemplate;
};

type IdempotencyRecord = {
  status: "in_progress" | "completed";
  requestFingerprintHash: string;
  metadata: Record<string, unknown> | null;
};

function targetPrivateNotesPool(): {
  auditEvents: Array<{ auditKey: string; action: string }>;
  calls: QueryCall[];
  notes: PrivateNoteRecord[];
  now(): Date;
  pool: PmsOperationsCommandPool;
} {
  const calls: QueryCall[] = [];
  const auditEvents: Array<{ auditKey: string; action: string }> = [];
  const auditKeys = new Set<string>();
  const idempotencyRows = new Map<string, IdempotencyRecord>();
  const notes = new Map<string, PrivateNoteRecord>();
  const templates = new Map<string, TemplateRecord>();
  const reservations = new Set([
    `${defaultPropertyId}:${defaultGuestBookingId}`,
    `${"f6853000-0000-0000-0000-000000000002"}:${"f6854000-0000-0000-0000-000000000002"}`,
  ]);
  let noteSequence = 1;
  let nowSequence = 0;

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    calls.push({ text, values });

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return emptyRows<T>();

    if (text.includes("FROM booking.guest_bookings")) {
      return reservations.has(`${String(values?.[0])}:${String(values?.[1])}`)
        ? rows([{ exists: 1 } as unknown as T])
        : emptyRows<T>();
    }

    if (text.includes("FROM platform.idempotency_keys")) {
      const key = idempotencyRecordKey(
        String(values?.[0]),
        String(values?.[2]),
        String(values?.[1]),
      );
      const record = idempotencyRows.get(key);
      return record
        ? rows([
            {
              status: record.status,
              requestFingerprintHash: record.requestFingerprintHash,
              idempotencyMetadata: record.metadata,
            } as unknown as T,
          ])
        : emptyRows<T>();
    }

    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      const key = idempotencyRecordKey(
        String(values?.[0]),
        String(values?.[3]),
        String(values?.[1]),
      );
      if (idempotencyRows.has(key)) return emptyRows<T>();
      idempotencyRows.set(key, {
        status: "in_progress",
        requestFingerprintHash: String(values?.[2]),
        metadata: JSON.parse(String(values?.[6])) as Record<string, unknown>,
      });
      return rows([{ id: `idem-${idempotencyRows.size}` } as unknown as T]);
    }

    if (text.includes("INSERT INTO pms.booking_notes_private")) {
      const noteId = `f6855900-0000-0000-0000-${String(noteSequence).padStart(12, "0")}`;
      noteSequence += 1;
      const note: PmsPrivateNote = {
        noteId,
        body: String(values?.[4]),
        authorUserId: String(values?.[2]),
        authorDisplayName: String(values?.[3]),
        createdAt: String(values?.[5]),
        auditMetadata: {
          source: "pms",
          createdByUserId: String(values?.[2]),
          createdByDisplayName: String(values?.[3]),
          createdAt: String(values?.[5]),
          privacyScope: "internal",
        },
      };
      notes.set(noteId, {
        propertyId: String(values?.[0]),
        guestBookingId: String(values?.[1]),
        note,
      });
      return rows([
        {
          noteId,
          body: note.body,
          authorUserId: note.authorUserId,
          authorDisplayName: note.authorDisplayName,
          source: "pms",
          createdAt: note.createdAt,
        } as unknown as T,
      ]);
    }

    if (text.includes("DELETE FROM pms.booking_notes_private")) {
      const [noteId, propertyId, guestBookingId] = values ?? [];
      const record = notes.get(String(noteId));
      if (!record || record.propertyId !== propertyId || record.guestBookingId !== guestBookingId) {
        return emptyRows<T>();
      }
      notes.delete(String(noteId));
      return rows([{ noteId } as unknown as T]);
    }

    if (
      text.includes("FROM pms.checkin_checklist_templates") ||
      text.includes("FROM pms.checkout_inspection_templates")
    ) {
      const templateKind = text.includes("pms.checkin_checklist_templates")
        ? "check_in_checklist"
        : "check_out_inspection";
      const record = templates.get(`${templateKind}:${String(values?.[0])}`);
      return record
        ? rows([
            {
              propertyId: record.propertyId,
              steps: record.template.steps,
              updatedByUserId: record.template.updatedByUserId,
              updatedAt: record.template.updatedAt,
            } as unknown as T,
          ])
        : emptyRows<T>();
    }

    if (
      text.includes("INSERT INTO pms.checkin_checklist_templates") ||
      text.includes("INSERT INTO pms.checkout_inspection_templates")
    ) {
      const templateKind = text.includes("pms.checkin_checklist_templates")
        ? "check_in_checklist"
        : "check_out_inspection";
      const propertyId = String(values?.[0]);
      const template: PmsOperationalTemplate = {
        propertyId,
        templateKind,
        steps: JSON.parse(String(values?.[1])) as PmsOperationalTemplate["steps"],
        updatedByUserId: String(values?.[2]),
        updatedAt: String(values?.[3]),
      };
      templates.set(`${templateKind}:${propertyId}`, { propertyId, template });
      return rows([
        {
          propertyId,
          steps: template.steps,
          updatedByUserId: template.updatedByUserId,
          updatedAt: template.updatedAt,
        } as unknown as T,
      ]);
    }

    if (text.includes("INSERT INTO platform.product_audit_events")) {
      const auditKey = String(values?.[0]);
      if (!auditKeys.has(auditKey)) {
        auditKeys.add(auditKey);
        auditEvents.push({ auditKey, action: String(values?.[1]) });
      }
      return emptyRows<T>();
    }

    if (text.includes("UPDATE platform.idempotency_keys")) {
      const key = idempotencyRecordKey(
        String(values?.[4]),
        String(values?.[6]),
        String(values?.[5]),
      );
      const record = idempotencyRows.get(key);
      if (record) {
        record.status = "completed";
        record.metadata = JSON.parse(String(values?.[3])) as Record<string, unknown>;
      }
      return emptyRows<T>();
    }

    return emptyRows<T>();
  };

  const client = {
    query,
    release() {},
  };

  return {
    auditEvents,
    calls,
    get notes() {
      return [...notes.values()];
    },
    now() {
      const date = new Date(Date.UTC(2026, 7, 14, 17, nowSequence, 0));
      nowSequence += 1;
      return date;
    },
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

function privateNoteCreateCommand(
  overrides: Partial<PmsPrivateNoteCreateCommand> = {},
): PmsPrivateNoteCreateCommand {
  return {
    propertyId: defaultPropertyId,
    guestBookingId: defaultGuestBookingId,
    actorUserId: "f6851000-0000-0000-0000-000000000001",
    authorDisplayName: "owner@example.com",
    commandId: "cmd-private-note-create-replay-test",
    idempotencyKey: "client-private-note-create",
    body: "Sentinel private note body: do not expose the anniversary surprise.",
    ...overrides,
  };
}

function templateUpdateCommand(
  templateKind: PmsOperationalTemplateUpdateCommand["templateKind"],
  overrides: Partial<PmsOperationalTemplateUpdateCommand> = {},
): PmsOperationalTemplateUpdateCommand {
  return {
    propertyId: defaultPropertyId,
    templateKind,
    actorUserId: "f6851000-0000-0000-0000-000000000001",
    commandId: "cmd-checklist-template",
    idempotencyKey: "client-checklist-template",
    steps: [{ stepId: "passport", label: "Verify passport", required: true }],
    ...overrides,
  };
}

function idempotencyRecordKey(operation: string, propertyId: string, keyHash: string): string {
  return `${operation}:${propertyId}:${keyHash}`;
}

function rows<T extends QueryResultRow>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}

function emptyRows<T extends QueryResultRow>(): { rows: T[]; rowCount: number } {
  return rows<T>([]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const unusedReadRepository = {} as PmsOperationsReadRepository;
