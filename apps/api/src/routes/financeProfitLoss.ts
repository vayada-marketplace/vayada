import { UnauthorizedError } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  assertFinanceProfitLossResponse,
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceProfitLossQuery,
  type FinanceProfitLossExpenseCategoryRow,
  type FinanceProfitLossQuery,
  type FinanceProfitLossResponse,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  FinanceProfitLossEvidenceError,
  type FinanceProfitLossReadModel,
} from "../domains/financeProfitLossReadModel.js";
import { isCanonicalFinanceTimeZone } from "../domains/financeRevenueReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export type FinanceProfitLossRoutesOptions = {
  propertyAccessRepository?: PropertyAccessRepository;
  read: Pick<FinanceProfitLossReadModel, "profitLoss">;
};

const PATH = "/finance/properties/:propertyId/financials/profit-loss";
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
  "months",
];

export async function registerFinanceProfitLossRoutes(
  app: FastifyInstance,
  options: FinanceProfitLossRoutesOptions,
): Promise<void> {
  const scopes = new WeakMap<FastifyRequest, string>();
  app.get(
    PATH,
    { onRequest: authorize(scopes, options.propertyAccessRepository) },
    async (request, reply) =>
      safe(reply, async () => {
        const query = parseFinanceProfitLossQuery(request.query);
        if (!query) return bad(reply);
        const propertyId = scopes.get(request)!;
        const result = await options.read.profitLoss(propertyId, query);
        if (result === null) return reply.status(404).send({ code: "not_found" });
        return profitLoss(result.response, propertyId, query, result.categoryRows)
          ? reply.send(result.response)
          : violation(reply);
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
function profitLoss(value: unknown, propertyId: string, query: FinanceProfitLossQuery, categoryRows: readonly FinanceProfitLossExpenseCategoryRow[]): value is FinanceProfitLossResponse {
  if (!record(value) || !exact(value, BASE) || value.contractVersion !== PMS_FINANCIALS_CONTRACT_VERSION || value.propertyId !== propertyId || !currency(value.currency) || !isCanonicalFinanceTimeZone(value.timeZone) || !utc(value.generatedAt) || !stringRecord(value.sourceFreshness) || !Array.isArray(value.incompleteEvidence) || !value.incompleteEvidence.every(incomplete) || !summary(value.summary, value.currency) || !Array.isArray(value.months)) return false;
  const code = value.currency;
  if (!value.months.every((month) => monthRecord(month, code))) return false;
  try { assertFinanceProfitLossResponse(value as FinanceProfitLossResponse, query, localAsOf(value.generatedAt, value.timeZone), categoryRows); return true; } catch { return false; }
}
// prettier-ignore
function summary(value: unknown, code: string) { return record(value) && exact(value, ["revenueYtd", "expensesYtd", "netProfitYtd"]) && [value.revenueYtd, value.expensesYtd, value.netProfitYtd].every((metric) => record(metric) && exact(metric, ["value", "absoluteChange", "percentChange"]) && money(metric.value, code) && money(metric.absoluteChange, code) && (metric.percentChange === null || decimal(metric.percentChange))); }
// prettier-ignore
function monthRecord(value: unknown, code: string) { return record(value) && exact(value, ["month", "roomRevenue", "upsellRevenue", "revenue", "expenses", "netProfit", "expenseCategories"]) && typeof value.month === "string" && [value.roomRevenue, value.upsellRevenue, value.revenue, value.expenses, value.netProfit].every((part) => money(part, code)) && record(value.expenseCategories) && Object.values(value.expenseCategories).every((part) => money(part, code)); }
// prettier-ignore
function incomplete(value: unknown) { if (!record(value) || !text(value.code) || !integer(value.count, 0)) return false; if (Object.hasOwn(value, "amount")) return exact(value, ["code", "count", "amount"]) && money(value.amount); if (Object.hasOwn(value, "currency")) return exact(value, ["code", "count", "currency"]) && currency(value.currency); return exact(value, ["code", "count"]); }
// prettier-ignore
function money(value: unknown, code?: string) { return record(value) && exact(value, ["amount", "currency"]) && decimal(value.amount) && currency(value.currency) && (!code || value.currency === code); }
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
function currency(value: unknown): value is string { return typeof value === "string" && /^[A-Z]{3}$/.test(value); }
// prettier-ignore
function utc(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19); }
function stringRecord(value: unknown) {
  return record(value) && Object.entries(value).every(([key, part]) => text(key) && text(part));
}
function localAsOf(instant: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

// prettier-ignore
async function safe(reply: FastifyReply, work: () => Promise<unknown>) { try { return await work(); } catch (cause) { if (cause instanceof FinanceProfitLossEvidenceError) return reply.status(422).send({ code: cause.code }); return violation(reply); } }
const bad = (reply: FastifyReply) => reply.status(400).send({ code: "invalid_request" });
const violation = (reply: FastifyReply) =>
  reply.status(500).send({ code: "finance_profit_loss_port_contract_violation" });
