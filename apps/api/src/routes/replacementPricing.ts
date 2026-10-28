import { parseBookingPricingOfferTerms } from "../domains/bookingPricingOfferTerms.js";
import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parsePricingConfiguration,
  pricingCurrencyScale,
  pricingInteger,
  pricingKeys,
  pricingObject,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { createReplacementPricingCommands } from "../domains/replacementPricingCommands.js";
import type { FinanceManualPaymentMethodsReadPort } from "../domains/financeManualPaymentReadiness.js";
import type { PricingCardReadinessReadPort } from "../domains/pricingCardReadiness.js";
import type { PricingGuestDisplayRateReadPort } from "../domains/pricingGuestDisplayRate.js";
import {
  pricingPaymentsNow,
  pricingRateNotSelling,
  type PricingCardState,
} from "../domains/pricingRatePayability.js";
import {
  PricingStorageError,
  type PricingStorageSnapshot,
  type PricingStorageSources,
} from "../domains/replacementPricingStore.js";
import { enforceRoutePolicy } from "./policy.js";

type Commands = ReturnType<typeof createReplacementPricingCommands>;
export type ReplacementPricingRoutesOptions = {
  commands(context: RequestContext): Commands;
  /** Present only while bank-transfer and PayPal acceptance is on (VAY-2139). */
  manualPayments?: FinanceManualPaymentMethodsReadPort;
  /** Whether rates can take card and deposits on the booking page now (VAY-2205). */
  cardReadiness?: PricingCardReadinessReadPort;
  /** Whether the booking page takes bank transfer bookings (its bank-transfer operations are
   * configured), as the public catalog decides (VAY-2304). */
  bankTransfers?: boolean;
  /** The currency guests see first and the booking page's rate to it (VAY-2390); none without the read. */
  guestDisplayRate?: PricingGuestDisplayRateReadPort;
};
type Params = { propertyId: string; draftId?: string; roomTypeId?: string; offerId?: string };
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  pricingObject(v) && pricingKeys(v, keys);
const revision = (v: unknown) => pricingInteger(v) && (v as number) < 2147483647;
const references = (v: unknown): v is PricingStorageSources =>
  pricingObject(v) &&
  Object.keys(v).length > 0 &&
  Object.entries(v).every(
    ([k, x]) =>
      k.trim() === k && k.length > 0 && typeof x === "string" && x.trim() === x && x.length > 0,
  );
const sources = (v: unknown): v is PricingStorageSources =>
  exact(v, ["room", "terms", "finance"]) && references(v);
const owners = (v: unknown): v is PricingStorageSources =>
  references(v) &&
  Object.hasOwn(v, "finance") &&
  Object.keys(v).every((key) => key === "finance" || key === "charges");
const snapshot = (v: unknown): v is PricingStorageSnapshot =>
  exact(v, ["currency", "rooms", "ownerReferences"]) &&
  typeof v.currency === "string" &&
  pricingCurrencyScale(v.currency) !== null &&
  Array.isArray(v.rooms) &&
  v.rooms.length > 0 &&
  v.rooms.every((r) => parsePricingConfiguration(r) !== null) &&
  owners(v.ownerReferences);
/** Terms the hotel can fix: they break a payment rule (VAY-2280, VAY-2205). */
const payloadRule = (code: string): boolean =>
  code === "non_refundable_pay_at_property" ||
  code === "payment_methods_required" ||
  code === "deposits_unavailable" ||
  code.startsWith("deposit_");
const invalid = (): never => {
  throw new PricingStorageError("invalid");
};
function effective(body: Record<string, unknown>) {
  if (!Object.hasOwn(body, "effectiveSources")) return {};
  return sources(body.effectiveSources) ? { effectiveSources: body.effectiveSources } : invalid();
}
function key(request: FastifyRequest): string {
  const count = request.raw.rawHeaders.filter(
    (v, i) => i % 2 === 0 && v.toLowerCase() === "idempotency-key",
  ).length;
  const value = request.headers["idempotency-key"];
  return count === 1 &&
    typeof value === "string" &&
    !value.includes(",") &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 200
    ? value
    : invalid();
}

export async function registerReplacementPricingRoutes(
  app: FastifyInstance,
  options: ReplacementPricingRoutesOptions,
) {
  const authorized = new WeakMap<FastifyRequest, RequestContext>();
  function route(
    method: "GET" | "POST" | "PUT",
    suffix: string,
    run: (
      commands: Commands,
      propertyId: string,
      request: FastifyRequest<{ Params: Params }>,
    ) => Promise<unknown>,
  ) {
    app.route<{ Params: Params }>({
      method,
      url: `/properties/:propertyId/pricing-v2${suffix}`,
      async onRequest(request, reply) {
        try {
          const permission = method === "GET" ? "pms.rooms_rates.read" : "pms.rooms_rates.manage";
          const base = enforceRoutePolicy(request, { permission });
          if (base.selectedOrganization.kind !== "hotel_group")
            return reply.code(403).send({ code: "forbidden" });
          if (
            !uuid(request.params.propertyId) ||
            (request.params.draftId !== undefined && !uuid(request.params.draftId)) ||
            (request.params.roomTypeId !== undefined && !uuid(request.params.roomTypeId)) ||
            (request.params.offerId !== undefined &&
              (!request.params.offerId.length ||
                request.params.offerId.length > 200 ||
                request.params.offerId.trim() !== request.params.offerId))
          )
            return invalid();
          request.params.propertyId = request.params.propertyId.toLowerCase();
          const resource = {
            product: "pms",
            resourceType: "pms_property",
            resourceId: request.params.propertyId,
          } as const;
          authorized.set(
            request,
            enforceRoutePolicy(request, {
              permission,
              entitlement: { product: "pms", key: "property-management", resource },
              resource: { ...resource, allowedRelationships: ["owner", "operator"] },
            }),
          );
        } catch (error) {
          if (error instanceof UnauthorizedError)
            return reply.code(401).send({ code: "unauthenticated" });
          if (error instanceof AuthorizationError)
            return reply.code(403).send({ code: "forbidden" });
          if (error instanceof PricingStorageError)
            return reply.code(400).send({ code: "invalid" });
          throw error;
        }
      },
      async handler(request, reply) {
        try {
          const context = authorized.get(request);
          if (!context) return reply.code(401).send({ code: "unauthenticated" });
          const result = await run(options.commands(context), request.params.propertyId, request);
          return result === null
            ? reply.code(404).send({ code: "not_found" })
            : reply.code(200).send(result);
        } catch (error) {
          if (error instanceof PricingStorageError)
            return reply
              .code(
                error.code === "invalid" || payloadRule(error.code)
                  ? 400
                  : error.code === "denied"
                    ? 403
                    : 409,
              )
              .send({ code: error.code, ...(error.reason ? { reason: error.reason } : {}) });
          return reply.code(503).send({ code: "pricing_unavailable" });
        }
      },
    });
  }
  // Which of bank transfer and PayPal the rate pickers may offer: their acceptance is on and the
  // hotel takes them with their details in place (VAY-2139).
  route("GET", "/payment-methods", async (commands, id) => {
    if (!(await commands.authorizeRead(id))) throw new PricingStorageError("denied");
    return options.manualPayments
      ? {
          acceptanceEnabled: true,
          readyMethods: await options.manualPayments.acceptedMethods({ propertyId: id }),
        }
      : { acceptanceEnabled: false, readyMethods: [] };
  });
  // Card and deposits for the rate screens' "Paid when booking" (VAY-2205); none without the read.
  route("GET", "/card-readiness", async (commands, id, request) => {
    if (!(await commands.authorizeRead(id))) throw new PricingStorageError("denied");
    const organizationId = authorized.get(request)!.selectedOrganization.organizationId;
    return options.cardReadiness
      ? options.cardReadiness.read({ organizationId, propertyId: id })
      : {
          card: { ready: false, reason: "switch_off", charge: "at_booking" },
          deposits: { ready: false },
        };
  });
  // VAY-2390: the Prices footer's "They see ≈ US$73 first", when guests start in another currency than the prices'.
  // A read that fails says nothing rather than guess; it is logged, never shown.
  route("GET", "/guest-display-rate", async (commands, id, request) => {
    if (!(await commands.authorizeRead(id))) throw new PricingStorageError("denied");
    const guestDisplay = await options.guestDisplayRate?.read(id).catch((error: unknown) => {
      request.log.error({ err: error }, "pricing guest display rate read failed");
      return null;
    });
    return { guestDisplay: guestDisplay ?? null };
  });
  // VAY-2304: the published rates guests can't pay now, why, and what fixes each, main fix first
  // (pricing-rates-not-selling.v1; the PMS rate cards show it). Every other rate sells.
  route("GET", "/not-selling", async (commands, id, request) => {
    const organizationId = authorized.get(request)!.selectedOrganization.organizationId;
    const published = await commands.publishedRatePayments(id);
    const ready = options.cardReadiness
      ? await options.cardReadiness.read({ organizationId, propertyId: id })
      : null;
    const manual = options.manualPayments
      ? await options.manualPayments.acceptedMethods({ propertyId: id })
      : [];
    // The same switches as the public catalog: bank transfer also needs the booking page's operations.
    const now = pricingPaymentsNow(published.methods, {
      card: ready?.card.ready === true,
      deposits: ready?.deposits.ready === true,
      manual: manual.filter(
        (method) => method !== "bank_transfer" || options.bankTransfers === true,
      ),
    });
    const card: PricingCardState =
      ready?.card.ready === true
        ? "ready"
        : !published.cardChosen
          ? "not_chosen"
          : ready?.card.reason === "not_connected"
            ? "setup_incomplete"
            : "off";
    return {
      version: "pricing-rates-not-selling.v1",
      publishedRevision: published.publishedRevision,
      rates: published.rates.flatMap((terms) => {
        const why = pricingRateNotSelling(terms, { ...now, card });
        return why ? [{ roomTypeId: terms.roomTypeId, offerId: terms.offerId, ...why }] : [];
      }),
    };
  });
  route("GET", "/rooms/:roomTypeId/offers/:offerId/terms", (commands, id, request) =>
    commands.readTerms(id, request.params.roomTypeId!, request.params.offerId!),
  );
  route("PUT", "/rooms/:roomTypeId/offers/:offerId/terms", async () => {
    throw new PricingStorageError("denied");
  });
  route(
    "PUT",
    "/drafts/:draftId/rooms/:roomTypeId/offers/:offerId/terms",
    async (commands, id, request) => {
      const requestId = key(request),
        body = request.body;
      if (
        !exact(body, ["expectedRevision", "baseRevision", "cancellation", "payment"]) ||
        !revision(body.baseRevision) ||
        !(body.expectedRevision === null || uuid(body.expectedRevision))
      )
        return invalid();
      const parsed = parseBookingPricingOfferTerms({
        roomTypeId: request.params.roomTypeId,
        offerId: request.params.offerId,
        revision: request.params.roomTypeId,
        cancellation: body.cancellation,
        payment: body.payment,
      });
      if (!parsed) return invalid();
      const { revision: _revision, ...terms } = parsed;
      // A deposit needs the hotel's card ready and deposits switched on (VAY-2205).
      const depositsReady =
        terms.payment.kind === "deposit" && options.cardReadiness
          ? (
              await options.cardReadiness.read({
                organizationId: authorized.get(request)!.selectedOrganization.organizationId,
                propertyId: id,
              })
            ).deposits.ready
          : false;
      return commands.stageTerms(
        id,
        { requestId, expectedRevision: body.expectedRevision, terms },
        { draftId: request.params.draftId!, baseRevision: body.baseRevision as number },
        depositsReady,
      );
    },
  );
  route(
    "GET",
    "/drafts/:draftId/rooms/:roomTypeId/offers/:offerId/terms",
    (commands, id, request) => {
      const query = request.query;
      if (
        !exact(query, ["revision"]) ||
        typeof query.revision !== "string" ||
        !/^[1-9][0-9]*$/.test(query.revision) ||
        !revision(Number(query.revision))
      )
        return invalid();
      return commands.readDraftTerms(
        id,
        request.params.draftId!,
        Number(query.revision),
        request.params.roomTypeId!,
        request.params.offerId!,
      );
    },
  );
  route("GET", "/drafts/:draftId/charge-review", (commands, id, request) =>
    commands.reviewCharges(id, request.params.draftId!),
  );
  route("GET", "", (commands, id) => commands.read(id));
  route("GET", "/drafts/:draftId", (commands, id, request) =>
    commands.readDraft(id, request.params.draftId!),
  );
  route("POST", "/prepare", (commands, id, request) => {
    const body = request.body;
    if (
      !(exact(body, ["currency", "rooms"]) || exact(body, ["currency", "rooms", "draft"])) ||
      typeof body.currency !== "string" ||
      pricingCurrencyScale(body.currency) === null ||
      !Array.isArray(body.rooms) ||
      !body.rooms.length ||
      body.rooms.some((r) => parsePricingConfiguration(r) === null)
    )
      return invalid();
    const draft = body.draft;
    if (
      draft !== undefined &&
      (!exact(draft, ["draftId", "baseRevision"]) ||
        !uuid(draft.draftId) ||
        !revision(draft.baseRevision))
    )
      return invalid();
    return commands.prepare(
      id,
      { currency: body.currency, rooms: body.rooms },
      draft as { draftId: string; baseRevision: number } | undefined,
    );
  });
  route("PUT", "/drafts/:draftId", async (commands, id, request) => {
    const body = request.body;
    if (
      !(
        exact(body, ["expectedDraftRevision", "baseRevision", "sources", "snapshot"]) ||
        exact(body, [
          "expectedDraftRevision",
          "baseRevision",
          "sources",
          "snapshot",
          "effectiveSources",
        ])
      ) ||
      !revision(body.expectedDraftRevision) ||
      !revision(body.baseRevision) ||
      !sources(body.sources) ||
      !snapshot(body.snapshot)
    )
      return invalid();
    const draftRevision = await commands.saveDraft(id, {
      draftId: request.params.draftId!,
      expectedDraftRevision: body.expectedDraftRevision as number,
      baseRevision: body.baseRevision as number,
      sources: body.sources,
      ...effective(body),
      snapshot: body.snapshot,
    });
    return { revision: draftRevision };
  });
  route("POST", "/charges", (commands, id, request) => {
    const requestId = key(request),
      body = request.body;
    if (
      !(
        exact(body, ["draftId", "expectedDraftRevision", "claimedFingerprint", "declaration"]) ||
        exact(body, [
          "draftId",
          "expectedDraftRevision",
          "claimedFingerprint",
          "declaration",
          "declaredVia",
        ])
      ) ||
      (Object.hasOwn(body, "declaredVia") && body.declaredVia !== "save_prices") ||
      !uuid(body.draftId) ||
      !revision(body.expectedDraftRevision) ||
      body.expectedDraftRevision === 0 ||
      typeof body.claimedFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.claimedFingerprint) ||
      body.declaration !== "all_mandatory_charges_included"
    )
      return invalid();
    return commands.confirmCharges(id, {
      draftId: body.draftId,
      expectedDraftRevision: body.expectedDraftRevision as number,
      claimedFingerprint: body.claimedFingerprint,
      declaration: body.declaration,
      ...(body.declaredVia === "save_prices" ? { declaredVia: "save_prices" as const } : {}),
      requestId,
    });
  });
  route("POST", "/publish", (commands, id, request) => {
    const requestId = key(request),
      body = request.body;
    if (
      !(
        exact(body, ["expectedRevision", "sources", "snapshot", "draft"]) ||
        exact(body, ["expectedRevision", "sources", "snapshot", "draft", "effectiveSources"])
      ) ||
      !revision(body.expectedRevision) ||
      !sources(body.sources) ||
      !snapshot(body.snapshot) ||
      !exact(body.draft, ["id", "revision"]) ||
      !uuid(body.draft.id) ||
      !revision(body.draft.revision) ||
      body.draft.revision === 0
    )
      return invalid();
    return commands.publish(id, {
      expectedRevision: body.expectedRevision as number,
      sources: body.sources,
      ...effective(body),
      snapshot: body.snapshot,
      draft: { id: body.draft.id, revision: body.draft.revision as number },
      requestId,
    });
  });
}
