import { UnauthorizedError } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import { PMS_FINANCIALS_CONTRACT_VERSION, parseFinanceRevenueQuery } from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  FinanceRevenueEvidenceError,
  isCanonicalFinanceTimeZone,
  type FinanceRevenueReadModel,
} from "../domains/financeRevenueReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export type FinanceRevenueRoutesOptions = {
  propertyAccessRepository?: PropertyAccessRepository;
  read: Pick<FinanceRevenueReadModel, "revenue">;
};

const PATH = "/finance/properties/:propertyId/financials/revenue";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = [
  "contractVersion",
  "propertyId",
  "currency",
  "timeZone",
  "generatedAt",
  "sourceFreshness",
  "incompleteEvidence",
  "summary",
  "channels",
  "directSources",
  "upsells",
  "roomTypes",
];

export async function registerFinanceRevenueRoutes(
  app: FastifyInstance,
  options: FinanceRevenueRoutesOptions,
): Promise<void> {
  const scopes = new WeakMap<FastifyRequest, string>();
  app.get(
    PATH,
    { onRequest: authorize(scopes, options.propertyAccessRepository) },
    async (request, reply) =>
      safe(reply, async () => {
        const query = parseFinanceRevenueQuery(request.query);
        if (!query) return bad(reply);
        const propertyId = scopes.get(request)!;
        const value = await options.read.revenue(propertyId, query);
        if (value === null) return reply.status(404).send({ code: "not_found" });
        return revenue(value, propertyId) ? reply.send(value) : violation(reply);
      }),
  );
}

// prettier-ignore
function authorize(scopes: WeakMap<FastifyRequest, string>, propertyAccessRepository?: PropertyAccessRepository) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let context = enforceRoutePolicy(request, { permission: "pms.finance.read" });
      if (context.selectedOrganization.kind !== "hotel_group") return void reply.status(403).send({ code: "forbidden" });
      const raw = (request.params as { propertyId?: unknown }).propertyId, propertyId = typeof raw === "string" && UUID.test(raw.toLowerCase()) ? raw.toLowerCase() : null; if (!propertyId) return void bad(reply);
      const resource = { product: "pms" as const, resourceType: "pms_property" as const, resourceId: propertyId };
      for (const key of ["property-management", "module:financials"]) context = enforceRoutePolicy(request, { permission: "pms.finance.read", entitlement: { product: "pms", key, resource }, resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] } });
      if (!propertyAccessRepository) throw new AuthorizationError();
      await requirePropertyAccess(context, propertyAccessRepository, { propertyId, targetResource: resource, allowedRelationships: ["owner", "finance_manager"] });
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization"); scopes.set(request, propertyId);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) return void reply.status(401).send({ code: "unauthenticated" });
      if (cause instanceof AuthorizationError) return void reply.status(403).send({ code: "forbidden" });
      throw cause;
    }
  };
}

// prettier-ignore
function revenue(value: unknown, propertyId: string): boolean {
  if (!record(value) || !exact(value, BASE) || value.contractVersion !== PMS_FINANCIALS_CONTRACT_VERSION || value.propertyId !== propertyId || !currency(value.currency) || !isCanonicalFinanceTimeZone(value.timeZone) || !utc(value.generatedAt) || !stringRecord(value.sourceFreshness) || !Array.isArray(value.incompleteEvidence) || !value.incompleteEvidence.every(incomplete)) return false;
  const code = value.currency;
  return summary(value.summary, code) && Array.isArray(value.channels) && value.channels.every((entry: unknown) => record(entry) && exact(entry, ["channel", "gross", "commission", "net", "share"]) && text(entry.channel) && [entry.gross, entry.commission, entry.net].every((part) => money(part, code)) && ratio(entry.share)) && Array.isArray(value.directSources) && value.directSources.every((entry: unknown) => record(entry) && exact(entry, ["source", "revenue", "share"]) && text(entry.source) && money(entry.revenue, code) && ratio(entry.share)) && Array.isArray(value.upsells) && value.upsells.every((entry: unknown) => record(entry) && exact(entry, ["ownership", "revenue"]) && (entry.ownership === "property" || entry.ownership === "partner") && money(entry.revenue, code)) && Array.isArray(value.roomTypes) && value.roomTypes.every((entry: unknown) => record(entry) && exact(entry, ["roomTypeId", "nights", "revenue", "adr"]) && uuid(entry.roomTypeId) && integer(entry.nights, 0) && money(entry.revenue, code) && money(entry.adr, code));
}
// prettier-ignore
function summary(value: unknown, code: string) { return record(value) && exact(value, ["grossRoom", "otaCommission", "netRoom", "upsell", "nights", "adr", "attachRate"]) && [value.grossRoom, value.otaCommission, value.netRoom, value.upsell, value.adr].every((part) => metric(part, code)) && countMetric(value.nights) && ratioMetric(value.attachRate); }
// prettier-ignore
function metric(value: unknown, code: string) { return record(value) && exact(value, ["value", "absoluteChange", "percentChange"]) && money(value.value, code) && money(value.absoluteChange, code) && (value.percentChange === null || decimal(value.percentChange)); }
// prettier-ignore
function countMetric(value: unknown) { return record(value) && exact(value, ["value", "absoluteChange", "percentChange"]) && integer(value.value, 0) && Number.isSafeInteger(value.absoluteChange) && (value.percentChange === null || decimal(value.percentChange)); }
// prettier-ignore
function ratioMetric(value: unknown) { return record(value) && exact(value, ["value", "absoluteChange", "percentChange"]) && ratio(value.value) && decimal(value.absoluteChange) && (value.percentChange === null || decimal(value.percentChange)); }
// prettier-ignore
function incomplete(value: unknown) { if (!record(value) || !text(value.code) || !integer(value.count, 0)) return false; if (Object.hasOwn(value, "amount")) return exact(value, ["code", "count", "amount"]) && money(value.amount); if (Object.hasOwn(value, "currency")) return exact(value, ["code", "count", "currency"]) && currency(value.currency); return exact(value, ["code", "count"]); }
// prettier-ignore
function money(value: unknown, code?: string) { return record(value) && exact(value, ["amount", "currency"]) && typeof value.amount === "string" && /^-?(?:0|[1-9]\d*)\.\d{4}$/.test(value.amount) && currency(value.currency) && (!code || value.currency === code); }
// prettier-ignore
function ratio(value: unknown) { if (typeof value !== "string" || !/^(?:0|1)\.\d{4}$/.test(value)) return false; const units = BigInt(value.replace(".", "")); return units >= 0n && units <= 10_000n; }
// prettier-ignore
function decimal(value: unknown) { return typeof value === "string" && /^-?(?:0|[1-9]\d*)\.\d{4}$/.test(value); }
// prettier-ignore
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
// prettier-ignore
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
// prettier-ignore
function text(value: unknown): value is string { return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 200; }
// prettier-ignore
function integer(value: unknown, min: number) { return Number.isSafeInteger(value) && Number(value) >= min; }
// prettier-ignore
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
// prettier-ignore
function currency(value: unknown): value is string { return typeof value === "string" && /^[A-Z]{3}$/.test(value); }
// prettier-ignore
function utc(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19); }
function stringRecord(value: unknown) {
  return record(value) && Object.entries(value).every(([key, part]) => text(key) && text(part));
}

// prettier-ignore
async function safe(reply: FastifyReply, work: () => Promise<unknown>) { try { return await work(); } catch (cause) { if (cause instanceof FinanceRevenueEvidenceError) return reply.status(422).send({ code: cause.code }); return violation(reply); } }
const bad = (reply: FastifyReply) => reply.status(400).send({ code: "invalid_request" });
const violation = (reply: FastifyReply) =>
  reply.status(500).send({ code: "finance_revenue_port_contract_violation" });
