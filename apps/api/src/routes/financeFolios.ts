import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  FINANCE_FOLIO_CSV_CONTENT_TYPE,
  FINANCE_FOLIO_CSV_VERSION,
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceFolioExportFilters,
  parseFinanceFolioExportSnapshot,
  parseFinanceFolioQuery,
  parseFinanceFolioRevisionCommand,
  parseFinanceFolioWrite,
  type FinanceCommandAudit,
  type FinanceFolioDetailResponse,
  type FinanceFolioListResponse,
  type FinanceFolioQuery,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  type FinanceFolioExportCommand,
  type FinanceFolioExportEnqueueResult,
  type FinanceFolioExportStatus,
} from "../domains/financeFolioExportRepository.js";
import {
  type FinanceFolioCommandResult,
  type CreateFinanceFolioCommand,
  type CorrectFinanceFolioCommand,
  type TransitionFinanceFolioCommand,
} from "../domains/financeFolioCommandRepository.js";
import {
  canonicalFinanceFolioZone,
  FinanceFolioCursorError,
  FinanceFolioEvidenceError,
  isFinanceFolioCursor,
  type FinanceFolioReadRepository,
} from "../domains/financeFolioReadRepository.js";
import { enforceRoutePolicy } from "./policy.js";
import {
  createPrivateDownloadPolicy,
  type PlatformMediaServingConfig,
} from "../platform/mediaServing.js";
import type { PlatformMediaPrivateDownloadSigner } from "../platform/platformMediaS3.js";

type Params = { propertyId: string; folioId?: string; exportId?: string };
type Scope = { context: RequestContext; propertyId: string };
export type FinanceFolioRoutesOptions = {
  propertyAccessRepository?: PropertyAccessRepository;
  repository: Pick<FinanceFolioReadRepository, "list" | "detail" | "captureReadyExport">;
  exports?: {
    enqueue(command: FinanceFolioExportCommand): Promise<FinanceFolioExportEnqueueResult>;
  };
  exportDownloads?: {
    read: {
      find(input: {
        exportId: string;
        organizationId: string;
        propertyId: string;
        now: Date;
      }): Promise<FinanceFolioExportStatus | null>;
    };
    signer: PlatformMediaPrivateDownloadSigner;
    serving: PlatformMediaServingConfig;
    now?: () => Date;
  };
  commands?: {
    create(command: CreateFinanceFolioCommand): Promise<FinanceFolioCommandResult>;
    correct(command: CorrectFinanceFolioCommand): Promise<FinanceFolioCommandResult>;
    ready(command: TransitionFinanceFolioCommand): Promise<FinanceFolioCommandResult>;
    archive(command: TransitionFinanceFolioCommand): Promise<FinanceFolioCommandResult>;
  };
};

const ROOT = "/finance/properties/:propertyId/financials/folios";
const EXPORT_ROOT = "/finance/properties/:propertyId/financials/exports";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function registerFinanceFolioRoutes(
  app: FastifyInstance,
  options: FinanceFolioRoutesOptions,
): Promise<void> {
  const scopes = new WeakMap<FastifyRequest, Scope>();
  const read = authorization(scopes, "pms.finance.read", options.propertyAccessRepository);
  const write = authorization(scopes, "pms.finance.manage", options.propertyAccessRepository);

  app.get(ROOT, { onRequest: read }, async (request, reply) =>
    safe(reply, async () => {
      const query = parseFinanceFolioQuery(request.query);
      if (!query) return bad(reply);
      const propertyId = scopes.get(request)!.propertyId;
      const value = await options.repository.list(propertyId, query);
      return value ? reply.send(listResponse(value, propertyId, query)) : missing(reply);
    }),
  );

  app.get(`${ROOT}/:folioId`, { onRequest: read }, async (request, reply) =>
    safe(reply, async () => {
      const folioId = canonicalUuid((request.params as Params).folioId);
      if (!folioId || !empty(request.query)) return bad(reply);
      const propertyId = scopes.get(request)!.propertyId;
      const value = await options.repository.detail(propertyId, folioId);
      return value ? reply.send(detailResponse(value, propertyId)) : missing(reply);
    }),
  );

  if (options.exports)
    app.post(EXPORT_ROOT, { onRequest: read }, async (request, reply) =>
      safe(reply, async () => {
        const value = exportRequest(request.body);
        if (!empty(request.query) || !value || !headerMatches(request, value.idempotencyKey))
          return bad(reply);
        const current = scopes.get(request)!;
        const rawCapture = await options.repository.captureReadyExport(
          current.propertyId,
          value.filters,
        );
        if (!rawCapture) return missing(reply);
        const capture = exportCapture(rawCapture, current.propertyId, value.filters);
        return exportResponse(
          reply,
          await options.exports!.enqueue({
            ...value,
            organizationId: current.context.selectedOrganization.organizationId,
            propertyId: current.propertyId,
            currency: capture.snapshot.currency,
            snapshot: capture.snapshot,
            envelope: capture.envelope,
            audit: {
              actorUserId: current.context.actor.internalUserId,
              requestId: current.context.audit.requestId,
              correlationId: current.context.audit.correlationId ?? current.context.audit.requestId,
              causationId: value.commandId,
              requestedAt: current.context.audit.receivedAt,
            },
          }),
          current.propertyId,
        );
      }),
    );

  if (options.exportDownloads)
    app.get(`${EXPORT_ROOT}/:exportId`, { onRequest: read }, async (request, reply) =>
      safe(reply, async () => {
        const exportId = canonicalUuid((request.params as Params).exportId);
        if (!exportId || !empty(request.query)) return bad(reply);
        const current = scopes.get(request)!,
          now = options.exportDownloads!.now?.() ?? new Date();
        const value = await options.exportDownloads!.read.find({
          exportId,
          organizationId: current.context.selectedOrganization.organizationId,
          propertyId: current.propertyId,
          now,
        });
        if (!value) return missing(reply);
        return exportStatusResponse(
          reply,
          value,
          current.propertyId,
          exportId,
          options.exportDownloads!,
        );
      }),
    );

  if (!options.commands) return;
  app.post(ROOT, { onRequest: write }, async (request, reply) =>
    safe(reply, async () => {
      const value = parseFinanceFolioWrite(request.body, "create");
      if (!empty(request.query) || !value || !headerMatches(request, value.idempotencyKey))
        return bad(reply);
      const current = scopes.get(request)!;
      return commandResponse(
        reply,
        current,
        value.commandId,
        await options.commands!.create({
          ...value,
          propertyId: current.propertyId,
          audit: audit(current, "finance.folio.create"),
        }),
      );
    }),
  );
  app.patch(`${ROOT}/:folioId`, { onRequest: write }, async (request, reply) =>
    safe(reply, async () => {
      const value = parseFinanceFolioWrite(request.body, "correct");
      const folioId = canonicalUuid((request.params as Params).folioId);
      if (
        !empty(request.query) ||
        !value ||
        !folioId ||
        !headerMatches(request, value.idempotencyKey)
      )
        return bad(reply);
      const current = scopes.get(request)!;
      return commandResponse(
        reply,
        current,
        folioId,
        await options.commands!.correct({
          ...value,
          folioId,
          propertyId: current.propertyId,
          audit: audit(current, "finance.folio.correct"),
        }),
      );
    }),
  );
  app.post(`${ROOT}/:folioId/ready`, { onRequest: write }, async (request, reply) =>
    transition(request, reply, scopes, options.commands!, "ready"),
  );
  app.delete(`${ROOT}/:folioId`, { onRequest: write }, async (request, reply) =>
    transition(request, reply, scopes, options.commands!, "archive"),
  );
}

async function exportStatusResponse(
  reply: FastifyReply,
  value: FinanceFolioExportStatus,
  propertyId: string,
  exportId: string,
  access: NonNullable<FinanceFolioRoutesOptions["exportDownloads"]>,
) {
  if (
    !record(value) ||
    !exact(
      value,
      value.state === "ready" ? ["state", "expiresAt", "artifact"] : ["state", "expiresAt"],
    ) ||
    !["pending", "running", "failed", "expired", "ready"].includes(String(value.state)) ||
    typeof value.expiresAt !== "string" ||
    !utc(value.expiresAt)
  )
    return commandViolation();
  const item: Record<string, unknown> = {
    resourceId: exportId,
    state: value.state,
    expiresAt: value.expiresAt,
  };
  if (value.state === "ready") {
    const artifact = value.artifact,
      signingAt = access.now?.() ?? new Date(),
      remaining = Math.floor((new Date(value.expiresAt).getTime() - signingAt.getTime()) / 1000);
    if (!Number.isFinite(remaining)) return commandViolation();
    if (remaining < 1)
      return reply.send({
        contractVersion: "pms-financials-export.v1",
        propertyId,
        item: { resourceId: exportId, state: "expired", expiresAt: value.expiresAt },
      });
    if (
      !record(artifact) ||
      !exact(artifact, [
        "mediaId",
        "bucketName",
        "storageKey",
        "visibility",
        "lifecycleStatus",
        "filename",
        "contentType",
        "sizeBytes",
      ]) ||
      artifact.mediaId !== exportId ||
      artifact.bucketName !== access.serving.bucketName ||
      artifact.storageKey !==
        `private/finance/financials-exports/${exportId}/${FINANCE_FOLIO_CSV_VERSION}.csv` ||
      artifact.visibility !== "private" ||
      artifact.lifecycleStatus !== "active" ||
      typeof artifact.bucketName !== "string" ||
      typeof artifact.storageKey !== "string" ||
      artifact.filename !== `pms-financials-folios-${propertyId}.csv` ||
      artifact.contentType !== FINANCE_FOLIO_CSV_CONTENT_TYPE ||
      typeof artifact.sizeBytes !== "number" ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    )
      return commandViolation();
    const policy = createPrivateDownloadPolicy(
        access.serving,
        {
          bucketName: artifact.bucketName,
          storageKey: artifact.storageKey,
          visibility: "private",
          status: "active",
          originalFilename: artifact.filename,
          contentType: artifact.contentType,
        },
        { ttlSeconds: Math.min(access.serving.privateDownloadTtlSeconds, remaining) },
      ),
      url = await access.signer.signPrivateDownload(policy);
    if (!secureUrl(url)) return commandViolation();
    item.download = {
      method: "GET",
      url,
      expiresAt: new Date(signingAt.getTime() + policy.expiresInSeconds * 1000).toISOString(),
    };
    item.artifact = {
      mediaId: artifact.mediaId,
      filename: artifact.filename,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    };
  }
  return reply.send({ contractVersion: "pms-financials-export.v1", propertyId, item });
}

function exportResponse(
  reply: FastifyReply,
  value: FinanceFolioExportEnqueueResult,
  propertyId: string,
) {
  if (!record(value)) return commandViolation();
  if (value.status === "conflict")
    return exact(value, ["status"])
      ? reply.status(409).send({ code: "idempotency_key_reused" })
      : commandViolation();
  if (!["created", "replayed"].includes(String(value.status))) return commandViolation();
  const exportId = canonicalUuid(value.exportId);
  const parsed = envelope.safeParse(value.envelope);
  if (
    !exportId ||
    !exact(value, ["status", "exportId", "envelope"]) ||
    !parsed.success ||
    parsed.data.propertyId !== propertyId ||
    parsed.data.incompleteEvidence.some(
      (item) => item.amount && item.amount.currency !== parsed.data.currency,
    )
  )
    return commandViolation();
  return reply.status(value.status === "created" ? 202 : 200).send({
    ...parsed.data,
    item: { resourceId: exportId, state: "pending" },
    outcome: value.status,
  });
}

// prettier-ignore
function exportCapture(value: unknown, propertyId: string, filters: NonNullable<ReturnType<typeof parseFinanceFolioExportFilters>>) {
  if (!record(value) || !exact(value, ["envelope", "snapshot"])) return commandViolation();
  const parsedEnvelope = envelope.safeParse(value.envelope);
  const snapshot = parseFinanceFolioExportSnapshot(value.snapshot);
  if (!parsedEnvelope.success || !snapshot || parsedEnvelope.data.propertyId !== propertyId || snapshot.propertyId !== propertyId || parsedEnvelope.data.currency !== snapshot.currency || parsedEnvelope.data.incompleteEvidence.some((item) => item.amount && item.amount.currency !== parsedEnvelope.data.currency) || JSON.stringify(snapshot.filters) !== JSON.stringify(filters)) return commandViolation();
  return { envelope: parsedEnvelope.data, snapshot };
}

function exportRequest(value: unknown) {
  if (!record(value) || !exact(value, ["commandId", "idempotencyKey", "tab", "filters", "format"]))
    return null;
  const commandId = canonicalUuid(value.commandId);
  const filters = parseFinanceFolioExportFilters(value.filters);
  if (
    !commandId ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey !== value.idempotencyKey.trim() ||
    value.idempotencyKey.length < 8 ||
    value.idempotencyKey.length > 200 ||
    value.tab !== "folios" ||
    value.format !== "csv" ||
    !filters
  )
    return null;
  return { commandId, idempotencyKey: value.idempotencyKey, filters };
}

function authorization(
  scopes: WeakMap<FastifyRequest, Scope>,
  permission: "pms.finance.read" | "pms.finance.manage",
  propertyAccessRepository: PropertyAccessRepository | undefined,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let context = enforceRoutePolicy(request, { permission });
      if (context.selectedOrganization.kind !== "hotel_group") throw new AuthorizationError();
      const propertyId = canonicalUuid((request.params as Partial<Params>).propertyId);
      if (!propertyId) return void bad(reply);
      const resource = {
        product: "pms" as const,
        resourceType: "pms_property" as const,
        resourceId: propertyId,
      };
      for (const key of ["property-management", "module:financials"])
        context = enforceRoutePolicy(request, {
          permission,
          entitlement: { product: "pms", key, resource },
          resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] },
        });
      if (!propertyAccessRepository) throw new AuthorizationError();
      await requirePropertyAccess(context, propertyAccessRepository, {
        propertyId,
        targetResource: resource,
        allowedRelationships: ["owner", "finance_manager"],
      });
      reply.header("Cache-Control", "private, no-store").header("Vary", "Origin, Authorization");
      scopes.set(request, { context, propertyId });
    } catch (cause) {
      if (cause instanceof UnauthorizedError)
        return void reply.status(401).send({ code: "unauthenticated" });
      if (cause instanceof AuthorizationError)
        return void reply.status(403).send({ code: "forbidden" });
      throw cause;
    }
  };
}

async function transition(
  request: FastifyRequest,
  reply: FastifyReply,
  scopes: WeakMap<FastifyRequest, Scope>,
  commands: NonNullable<FinanceFolioRoutesOptions["commands"]>,
  action: "ready" | "archive",
) {
  return safe(reply, async () => {
    const value = parseFinanceFolioRevisionCommand(request.body);
    const folioId = canonicalUuid((request.params as Params).folioId);
    if (
      !empty(request.query) ||
      !value ||
      !folioId ||
      !headerMatches(request, value.idempotencyKey)
    )
      return bad(reply);
    const current = scopes.get(request)!;
    return commandResponse(
      reply,
      current,
      folioId,
      await commands[action]({
        ...value,
        folioId,
        propertyId: current.propertyId,
        audit: audit(current, `finance.folio.${action}`),
      }),
    );
  });
}

function commandResponse(
  reply: FastifyReply,
  scope: Scope,
  expectedFolioId: string,
  value: unknown,
) {
  if (!record(value) || typeof value.status !== "string") return commandViolation();
  if (value.status === "not_found")
    return exact(value, ["status"]) ? missing(reply) : commandViolation();
  if (value.status === "invalid_evidence")
    return exact(value, ["status"])
      ? reply.status(422).send({ code: "invalid_evidence" })
      : commandViolation();
  if (value.status === "conflict") {
    const reasons = [
      "revision_conflict",
      "revision_exhausted",
      "invalid_state",
      "idempotency_key_reused",
      "command_in_progress",
    ];
    return exact(value, ["status", "reason"]) &&
      typeof value.reason === "string" &&
      reasons.includes(value.reason)
      ? reply.status(409).send({ code: value.reason })
      : commandViolation();
  }
  if (
    !["created", "updated", "replayed"].includes(value.status) ||
    !exact(value, ["status", "folioId", "revision"]) ||
    typeof value.folioId !== "string" ||
    value.folioId !== expectedFolioId ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > 2_147_483_647
  )
    throw new Error("finance_folio_port_contract_violation");
  return reply.status(value.status === "created" ? 201 : 200).send({
    contractVersion: PMS_FINANCIALS_CONTRACT_VERSION,
    propertyId: scope.propertyId,
    resourceId: value.folioId,
    revision: value.revision,
    outcome: value.status,
  });
}

function commandViolation(): never {
  throw new Error("finance_folio_port_contract_violation");
}

const audit = (scope: Scope, reason: string): FinanceCommandAudit => ({
  actor: {
    kind: "user",
    userId: scope.context.actor.internalUserId,
    organizationId: scope.context.selectedOrganization.organizationId,
  },
  requestId: scope.context.audit.requestId,
  correlationId: scope.context.audit.correlationId,
  reason,
  requestedAt: scope.context.audit.receivedAt,
});

function headerMatches(request: FastifyRequest, key: string) {
  const header = request.headers["idempotency-key"];
  if (header === undefined) return true;
  const count = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  return count === 1 && typeof header === "string" && header === key;
}

// Runtime decoding protects the HTTP boundary even when an injected repository violates its TS type.
const id = z.string().regex(UUID);
const currency = z.string().regex(/^[A-Z]{3}$/);
const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{4}$/);
const instant = z.string().refine(utc);
const date = z.string().refine(localDate);
const money = z.object({ amount: decimal, currency }).strict();
// prettier-ignore
const summaryShape = { folioId: id, bookingId: id.nullable(), revision: z.number().int().positive(), state: z.enum(["draft", "ready", "superseded", "archived"]), serviceFrom: date, serviceTo: date, total: money, createdAt: instant };
const validInterval = (value: { serviceFrom: string; serviceTo: string }) =>
  value.serviceTo >= value.serviceFrom;
const folioSummary = z.object(summaryShape).strict().refine(validInterval);
// prettier-ignore
const envelope = z.object({ contractVersion: z.literal(PMS_FINANCIALS_CONTRACT_VERSION), propertyId: id, currency, timeZone: z.string().refine(canonicalFinanceFolioZone), generatedAt: instant, sourceFreshness: z.record(z.string(), z.string()), incompleteEvidence: z.array(z.object({ code: z.string(), count: z.number().int().nonnegative(), amount: money.optional() }).strict()) }).strict();
// prettier-ignore
const line = z.object({ lineId: id, position: z.number().int().positive(), kind: z.enum(["room", "addon", "fee", "tax", "adjustment"]), description: z.string(), quantity: decimal, unitAmount: money, total: money, serviceOn: date, source: z.object({ type: z.string(), id: z.string(), revision: z.number().int().positive() }).strict() }).strict();
// prettier-ignore
const folio = z.object({ ...summaryShape, propertyId: id, recipient: z.object({ name: z.string().refine(trimmed), email: z.string().refine(email).nullable() }).strict(), currency, lines: z.array(line), paymentRefs: z.array(z.object({ paymentId: id, amount: money }).strict()), sourceDigest: z.string().regex(/^[0-9a-f]{64}$/), sourceFreshness: z.record(z.string(), instant) }).strict().refine(validInterval);
const listSchema = envelope.extend({
  page: z
    .object({
      items: z.array(folioSummary),
      nextCursor: z.string().min(2).max(4096).nullable(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
});
const detailSchema = envelope.extend({ item: folio });

function listResponse(
  value: FinanceFolioListResponse,
  propertyId: string,
  query: FinanceFolioQuery,
) {
  const parsed = listSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.propertyId !== propertyId ||
    (parsed.data.page.nextCursor !== null &&
      !isFinanceFolioCursor(
        parsed.data.page.nextCursor,
        propertyId,
        parsed.data.currency,
        query,
      )) ||
    parsed.data.incompleteEvidence.some(
      (item) => item.amount && item.amount.currency !== parsed.data.currency,
    ) ||
    parsed.data.page.items.some((item) => item.total.currency !== parsed.data.currency)
  )
    throw new Error("finance_folio_port_contract_violation");
  return parsed.data;
}

function detailResponse(value: FinanceFolioDetailResponse, propertyId: string) {
  const parsed = detailSchema.safeParse(value);
  if (!parsed.success) throw new Error("finance_folio_port_contract_violation");
  const { data } = parsed;
  const currencies = [
    data.item.total.currency,
    ...data.item.lines.flatMap((item) => [item.unitAmount.currency, item.total.currency]),
    ...data.item.paymentRefs.map((item) => item.amount.currency),
  ];
  if (
    data.propertyId !== propertyId ||
    data.item.propertyId !== propertyId ||
    data.item.currency !== data.currency ||
    data.incompleteEvidence.some((item) => item.amount && item.amount.currency !== data.currency) ||
    currencies.some((value) => value !== data.currency)
  )
    throw new Error("finance_folio_port_contract_violation");
  return data;
}

const canonicalUuid = (value: unknown) =>
  typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
const empty = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
// prettier-ignore
function localDate(value: string) { if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
function trimmed(value: string) {
  return value.length > 0 && value === value.trim();
}
function email(value: string) {
  return trimmed(value) && value.includes("@");
}
function secureUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
// prettier-ignore
function utc(value: string) { const match = /^((?!0000)\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value); if (!match) return false; const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]),parsed=new Date(0); parsed.setUTCFullYear(year,month-1,day); parsed.setUTCHours(hour,minute,second,0); return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear()===year && parsed.getUTCMonth()===month-1 && parsed.getUTCDate()===day && parsed.getUTCHours()===hour && parsed.getUTCMinutes()===minute && parsed.getUTCSeconds()===second; }

async function safe(reply: FastifyReply, work: () => Promise<unknown>) {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof FinanceFolioCursorError) return bad(reply, cause.code);
    if (cause instanceof FinanceFolioEvidenceError)
      return reply.status(422).send({ code: cause.code });
    return reply.status(500).send({ code: "finance_folio_port_contract_violation" });
  }
}
const bad = (reply: FastifyReply, code = "invalid_request") => reply.status(400).send({ code });
const missing = (reply: FastifyReply) => reply.status(404).send({ code: "not_found" });
