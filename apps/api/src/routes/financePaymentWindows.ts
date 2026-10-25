import { requireAuthContext } from "@vayada/backend-auth";
import {
  BANK_TRANSFER_PAYMENT_DEADLINE_HOURS,
  parsePaymentMethodBookingWindows,
  type PaymentMethodBookingWindows,
} from "@vayada/domain-booking";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PaymentMethodWindowsRepository } from "../domains/pricingPaymentWindows.js";
import { isPostgresLockTimeoutError } from "../platform/postgresRuntime.js";
import {
  enforceFinancePropertyReadPolicy,
  enforceFinancePropertyWritePolicy,
  type FinanceRoutesOptions,
} from "./finance.js";

const path = "/finance/properties/:propertyId/payment-windows";

/** Booking Admin › Payments: when each payment method is offered, by how long before arrival the
 * guest books (VAY-2348). Same access as the hotel's payment settings. Windows change no price, so
 * a save neither re-publishes prices nor touches the payment settings row. */
export async function registerFinancePaymentWindowsRoutes(
  app: FastifyInstance,
  options: {
    repository: PaymentMethodWindowsRepository;
    propertyAccessRepository?: FinanceRoutesOptions["propertyAccessRepository"];
  },
) {
  app.addHook("onClose", async () => options.repository.close?.());
  const body = (propertyId: string, windows: PaymentMethodBookingWindows) => ({
    propertyId,
    /** Bank transfer's fixed payment deadline, shown as a rule. */
    paymentDeadlineHours: BANK_TRANSFER_PAYMENT_DEADLINE_HOURS,
    windows,
  });
  for (const method of ["GET", "PUT"] as const) {
    app.route<{ Params: { propertyId: string }; Body: unknown }>({
      method,
      url: path,
      bodyLimit: 4096,
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const enforce =
          method === "GET" ? enforceFinancePropertyReadPolicy : enforceFinancePropertyWritePolicy;
        if (
          !(await enforce(
            request,
            reply,
            request.params.propertyId,
            options.propertyAccessRepository,
          ))
        )
          return reply;
      },
      async handler(request, reply) {
        const propertyId = request.params.propertyId;
        if (!z.uuid().safeParse(propertyId).success)
          return reply.code(400).send({ code: "invalid_request" });
        let windows: PaymentMethodBookingWindows | undefined;
        if (method === "PUT") {
          const raw = request.body;
          const parsed =
            typeof raw === "object" && raw !== null && !Array.isArray(raw) && "windows" in raw
              ? Object.keys(raw).length === 1
                ? parsePaymentMethodBookingWindows(raw.windows)
                : null
              : null;
          if (!parsed || (!parsed.ok && parsed.problem === "invalid"))
            return reply.code(400).send({ code: "invalid_request" });
          if (!parsed.ok)
            return reply.code(422).send({
              code: parsed.problem,
              message: "A bank transfer window must be longer than its 48-hour payment deadline.",
            });
          windows = parsed.windows;
        }
        try {
          if (!windows) return body(propertyId, await options.repository.read(propertyId));
          const context = requireAuthContext(request);
          const saved = await options.repository.replace({
            propertyId,
            windows,
            audit: {
              actorUserId: context.actor.internalUserId,
              requestId: context.audit.requestId,
              correlationId: context.audit.correlationId ?? null,
            },
          });
          return body(propertyId, saved);
        } catch (error) {
          // Another save holds the hotel's lock: the app answers 409 busy_try_again.
          if (isPostgresLockTimeoutError(error)) throw error;
          request.log.error({ err: error, propertyId }, "Payment method windows unavailable");
          return reply.code(503).send({ code: "payment_windows_unavailable" });
        }
      },
    });
  }
}
