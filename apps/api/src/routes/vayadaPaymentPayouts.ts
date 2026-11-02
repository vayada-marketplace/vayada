import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type createVayadaPaymentPayoutRepository,
  vayadaPayoutCutoff,
} from "../domains/vayadaPaymentPayouts.js";
import { authorizePlatformFinance } from "./financePlatformAuthorization.js";

type Repository = Pick<
  ReturnType<typeof createVayadaPaymentPayoutRepository>,
  "list" | "detail" | "start" | "markSent" | "markReturned" | "revealDestination"
>;
type Mode = { mode?: string };
type PropertyParams = { propertyId: string };
type PayoutParams = PropertyParams & { payoutId: string };
type StartBody = {
  commandId?: unknown;
  mode?: unknown;
  currency?: unknown;
  cutoff?: unknown;
  amountMinor?: unknown;
  destinationId?: unknown;
};
type SentBody = { reference?: unknown; paidOn?: unknown };
type ReturnBody = { commandId?: unknown; reason?: unknown };
type RevealBody = { destinationId?: unknown };

const BASE = "/finance/platform/vayada-payment/payouts";

/** vayada Payment payouts for Vayada staff (VAY-2442 P5). Registered only while
 * VAYADA_PAYMENT_ENABLED is on. Live money by default; `mode=test` shows Stripe test-mode money,
 * which is paid out only as a test. A payout is started before the money is sent by hand (that
 * takes it off the hotel's balance), then marked sent with the transfer's reference. */
export async function registerVayadaPaymentPayoutRoutes(
  app: FastifyInstance,
  options: { repository: Repository; now?: () => Date },
) {
  const now = options.now ?? (() => new Date());
  const livemode = (mode: unknown) =>
    mode === "test" ? false : mode === "live" || mode === undefined ? true : null;

  app.get<{ Querystring: Mode }>(BASE, async (request, reply) => {
    if (!authorizePlatformFinance(request, reply, "read")) return reply;
    const live = livemode(request.query.mode);
    if (live === null) return invalid(reply);
    const cutoff = vayadaPayoutCutoff(now());
    return {
      mode: live ? "live" : "test",
      cutoff,
      hotels: await options.repository.list({ livemode: live, cutoff }),
    };
  });

  app.get<{ Params: PropertyParams; Querystring: Mode }>(
    `${BASE}/:propertyId`,
    async (request, reply) => {
      if (!authorizePlatformFinance(request, reply, "read")) return reply;
      const live = livemode(request.query.mode);
      if (live === null || !uuid(request.params.propertyId)) return invalid(reply);
      const cutoff = vayadaPayoutCutoff(now());
      const detail = await options.repository.detail({
        propertyId: request.params.propertyId.toLowerCase(),
        livemode: live,
        cutoff,
      });
      return detail ? { mode: live ? "live" : "test", cutoff, ...detail } : notFound(reply);
    },
  );

  app.post<{ Params: PropertyParams; Body: RevealBody }>(
    `${BASE}/:propertyId/destination/reveal`,
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "manage");
      if (!context) return reply;
      const expected = request.body?.destinationId;
      if (!uuid(request.params.propertyId) || (expected !== undefined && !uuid(expected)))
        return invalid(reply);
      const result = await options.repository.revealDestination(
        request.params.propertyId.toLowerCase(),
        context.actor.internalUserId,
        expected?.toLowerCase(),
      );
      if (result.status === "unavailable")
        return reply.code(503).send({
          statusCode: 503,
          code: "payout_destination_unavailable",
          message: "Bank details can't be read right now.",
        });
      if (result.status === "not_found") return notFound(reply, "payout_destination_not_found");
      if (result.status === "destination_changed") return destinationChanged(reply);
      reply.header("cache-control", "no-store");
      return {
        destinationId: result.destinationId,
        countryCode: result.countryCode,
        ...result.details,
      };
    },
  );

  app.post<{ Params: PropertyParams; Body: StartBody }>(
    `${BASE}/:propertyId`,
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "manage");
      if (!context) return reply;
      const body = request.body ?? {};
      const live = livemode(body.mode);
      if (
        live === null ||
        !uuid(request.params.propertyId) ||
        !uuid(body.commandId) ||
        !uuid(body.destinationId) ||
        typeof body.currency !== "string" ||
        !/^[A-Z]{3}$/.test(body.currency) ||
        !date(body.cutoff) ||
        typeof body.amountMinor !== "string" ||
        !/^[1-9]\d{0,17}$/.test(body.amountMinor)
      )
        return invalid(reply);
      // A page opened before Monday's cut-off moved shows last week's amount: never start it.
      const cutoff = vayadaPayoutCutoff(now());
      if (body.cutoff !== cutoff)
        return reply.code(409).send({
          statusCode: 409,
          code: "payout_cutoff_changed",
          message: "A new payout week started. Reload the page.",
          cutoff,
        });
      const result = await options.repository.start({
        propertyId: request.params.propertyId.toLowerCase(),
        commandId: body.commandId.toLowerCase(),
        livemode: live,
        currency: body.currency,
        cutoff,
        amountMinor: body.amountMinor,
        destinationId: body.destinationId.toLowerCase(),
        actorId: context.actor.internalUserId,
      });
      switch (result.status) {
        case "started":
          return reply.code(201).send({ payoutId: result.payoutId });
        case "replayed":
          return { payoutId: result.payoutId };
        case "no_destination":
          return reply.code(409).send({
            statusCode: 409,
            code: "payout_destination_missing",
            message: "The hotel has no payout account.",
          });
        case "destination_changed":
          return destinationChanged(reply);
        case "amount_changed":
          return reply.code(409).send({
            statusCode: 409,
            code: "payout_amount_changed",
            message: "What the hotel is owed changed. Check the new amount.",
            payNowMinor: result.payNowMinor,
          });
        case "busy":
          return busy(reply);
        default:
          return conflict(reply);
      }
    },
  );

  app.post<{ Params: PayoutParams; Body: SentBody }>(
    `${BASE}/:propertyId/:payoutId/sent`,
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "manage");
      if (!context) return reply;
      const body = request.body ?? {};
      // Paid on: never later than tomorrow (time zones), never well before the payout started.
      const latest = new Date(now().getTime() + 36 * 3600 * 1000).toISOString().slice(0, 10);
      if (
        !uuid(request.params.propertyId) ||
        !uuid(request.params.payoutId) ||
        typeof body.reference !== "string" ||
        body.reference.trim().length < 1 ||
        body.reference.trim().length > 200 ||
        !date(body.paidOn) ||
        body.paidOn > latest
      )
        return invalid(reply);
      const result = await options.repository.markSent({
        propertyId: request.params.propertyId.toLowerCase(),
        payoutId: request.params.payoutId.toLowerCase(),
        reference: body.reference.trim(),
        paidOn: body.paidOn,
        actorId: context.actor.internalUserId,
      });
      if (result.status === "not_found") return notFound(reply, "payout_not_found");
      if (result.status === "invalid_date") return invalid(reply);
      if (result.status === "busy") return busy(reply);
      if (result.status === "conflict") return conflict(reply);
      return { sent: true };
    },
  );

  app.post<{ Params: PayoutParams; Body: ReturnBody }>(
    `${BASE}/:propertyId/:payoutId/returned`,
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "manage");
      if (!context) return reply;
      const body = request.body ?? {};
      if (
        !uuid(request.params.propertyId) ||
        !uuid(request.params.payoutId) ||
        !uuid(body.commandId) ||
        typeof body.reason !== "string" ||
        body.reason.trim().length < 1 ||
        body.reason.trim().length > 500
      )
        return invalid(reply);
      const result = await options.repository.markReturned({
        propertyId: request.params.propertyId.toLowerCase(),
        payoutId: request.params.payoutId.toLowerCase(),
        commandId: body.commandId.toLowerCase(),
        reason: body.reason.trim(),
        actorId: context.actor.internalUserId,
      });
      if (result.status === "not_found") return notFound(reply, "payout_not_found");
      if (result.status === "busy") return busy(reply);
      if (result.status === "conflict") return conflict(reply);
      return { returned: true };
    },
  );
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    statusCode: 400,
    code: "invalid_request",
    category: "validation",
    message: "The request is invalid.",
  });
}
function notFound(reply: FastifyReply, code = "property_not_found") {
  return reply
    .code(404)
    .send({ statusCode: 404, code, category: "not_found", message: "Not found." });
}
function conflict(reply: FastifyReply) {
  return reply.code(409).send({
    statusCode: 409,
    code: "payout_conflict",
    message: "This was already recorded differently. Reload the page.",
  });
}
function busy(reply: FastifyReply) {
  return reply.code(409).send({
    statusCode: 409,
    code: "payout_busy",
    message: "Someone else is changing this hotel's payouts. Try again in a moment.",
  });
}
function destinationChanged(reply: FastifyReply) {
  return reply.code(409).send({
    statusCode: 409,
    code: "payout_destination_changed",
    message: "The hotel changed its payout account. Reload the page before paying.",
  });
}
