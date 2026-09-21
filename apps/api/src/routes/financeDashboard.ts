import { UnauthorizedError } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  FINANCE_DASHBOARD_WINDOW_DAYS,
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceDashboardQuery,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  FinanceDashboardEvidenceError,
  type FinanceDashboardReadModel,
} from "../domains/financeDashboardReadModel.js";
import { isCanonicalFinanceTimeZone } from "../domains/financeRevenueReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export type FinanceDashboardRoutesOptions = {
  propertyAccessRepository?: PropertyAccessRepository;
  read: Pick<FinanceDashboardReadModel, "dashboard">;
};

const PATH = "/finance/properties/:propertyId/financials/dashboard";
const ACCESS_PATH = "/finance/properties/:propertyId/financials/access";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = [
  "contractVersion",
  "propertyId",
  "currency",
  "timeZone",
  "generatedAt",
  "sourceFreshness",
  "incompleteEvidence",
  "cards",
  "daily",
  "upcoming",
];

export async function registerFinanceDashboardRoutes(
  app: FastifyInstance,
  options: FinanceDashboardRoutesOptions,
): Promise<void> {
  const scopes = new WeakMap<FastifyRequest, string>();
  app.get(
    ACCESS_PATH,
    { onRequest: authorize(scopes, options.propertyAccessRepository) },
    (_request, reply) => reply.status(204).send(),
  );
  app.get(
    PATH,
    { onRequest: authorize(scopes, options.propertyAccessRepository) },
    async (request, reply) =>
      safe(reply, async () => {
        const query = parseFinanceDashboardQuery(request.query);
        if (!query) return bad(reply);
        const propertyId = scopes.get(request)!;
        const value = await options.read.dashboard(propertyId, query);
        if (value === null) return reply.status(404).send({ code: "not_found" });
        return dashboard(value, propertyId, query.asOf) ? reply.send(value) : violation(reply);
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
function dashboard(value: unknown, propertyId: string, requestedAsOf?: string): boolean {
  if (!record(value) || !exact(value, BASE) || value.contractVersion !== PMS_FINANCIALS_CONTRACT_VERSION || value.propertyId !== propertyId || !currency(value.currency) || !isCanonicalFinanceTimeZone(value.timeZone) || !utc(value.generatedAt) || !stringRecord(value.sourceFreshness) || !Array.isArray(value.incompleteEvidence) || !value.incompleteEvidence.every(incomplete)) return false;
  const code = value.currency, asOf = requestedAsOf ?? localAsOf(value.generatedAt, value.timeZone), upcoming = value.upcoming;
  return localDate(asOf) && cards(value.cards, code) && daily(value.daily, code, asOf) && Array.isArray(upcoming) && upcoming.every((entry: unknown, index) => record(entry) && exact(entry, ["date", "kind", "amount", "predicted"]) && localDate(entry.date) && entry.date >= asOf && (index === 0 || entry.date >= (upcoming[index - 1] as { date: string }).date) && text(entry.kind) && money(entry.amount, code) && typeof entry.predicted === "boolean");
}
// prettier-ignore
function cards(value: unknown, code: string) { return record(value) && exact(value, ["revenueToday", "revenueMtd", "expensesMtd", "profitMtd"]) && [value.revenueToday, value.revenueMtd, value.expensesMtd, value.profitMtd].every((part) => metric(part, code)); }
// prettier-ignore
function daily(value: unknown, code: string, asOf: string) { return Array.isArray(value) && value.length === FINANCE_DASHBOARD_WINDOW_DAYS && (value.at(-1) as { date?: unknown } | undefined)?.date === asOf && value.every((entry: unknown, index) => record(entry) && exact(entry, ["date", "revenue", "expenses"]) && localDate(entry.date) && money(entry.revenue, code) && money(entry.expenses, code) && (index === 0 || entry.date === nextDate((value[index - 1] as { date: string }).date))); }
// prettier-ignore
function metric(value: unknown, code: string) { return record(value) && exact(value, ["value", "absoluteChange", "percentChange"]) && money(value.value, code) && money(value.absoluteChange, code) && (value.percentChange === null || decimal(value.percentChange)); }
// prettier-ignore
function incomplete(value: unknown) { if (!record(value) || !text(value.code) || !integer(value.count, 0)) return false; if (Object.hasOwn(value, "amount")) return exact(value, ["code", "count", "amount"]) && money(value.amount); if (Object.hasOwn(value, "currency")) return exact(value, ["code", "count", "currency"]) && currency(value.currency); return exact(value, ["code", "count"]); }
// prettier-ignore
function money(value: unknown, code?: string) { return record(value) && exact(value, ["amount", "currency"]) && typeof value.amount === "string" && /^-?(?:0|[1-9]\d*)\.\d{4}$/.test(value.amount) && currency(value.currency) && (!code || value.currency === code); }
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
// prettier-ignore
function localDate(value: unknown): value is string { if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
function nextDate(value: string) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
function localAsOf(instant: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}
function stringRecord(value: unknown) {
  return record(value) && Object.entries(value).every(([key, part]) => text(key) && text(part));
}

// prettier-ignore
async function safe(reply: FastifyReply, work: () => Promise<unknown>) { try { return await work(); } catch (cause) { if (cause instanceof FinanceDashboardEvidenceError) return reply.status(422).send({ code: cause.code }); return violation(reply); } }
const bad = (reply: FastifyReply) => reply.status(400).send({ code: "invalid_request" });
const violation = (reply: FastifyReply) =>
  reply.status(500).send({ code: "finance_dashboard_port_contract_violation" });
