import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createVayadaPaymentPayoutRepository } from "../domains/vayadaPaymentPayouts.js";
import { enforceFinancePropertyReadPolicy, type FinanceRoutesOptions } from "./finance.js";

type Repository = Pick<ReturnType<typeof createVayadaPaymentPayoutRepository>, "statement">;

/** The hotel's own vayada Payment payout statement (VAY-2584): what it is owed and when, each
 * payout and every line that adds to or takes from it, live money only. Owner only, like the
 * payout account (finance.billing.manage, VAY-2401). Registered only while VAYADA_PAYMENT_ENABLED
 * is on. It answers for any hotel the owner holds, also one taken off vayada Payment's lists that
 * is still owed money; a hotel that never used it gets an empty statement. */
export async function registerFinancePayoutStatementRoutes(
  app: FastifyInstance,
  options: {
    repository: Repository;
    propertyAccessRepository?: FinanceRoutesOptions["propertyAccessRepository"];
    now?: () => Date;
  },
) {
  const now = options.now ?? (() => new Date());
  app.get<{ Params: { propertyId: string } }>(
    "/finance/properties/:propertyId/payout-statement",
    {
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const allowed = await enforceFinancePropertyReadPolicy(
          request,
          reply,
          request.params.propertyId,
          options.propertyAccessRepository,
          { ownerOnly: true },
        );
        if (!allowed) return reply;
      },
    },
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!z.uuid().safeParse(propertyId).success)
        return reply.code(400).send({ code: "invalid_request" });
      try {
        return await options.repository.statement({ propertyId, today: now() });
      } catch (error) {
        request.log.error({ err: error, propertyId }, "payout statement read failed");
        return reply.code(503).send({ code: "payout_statement_unavailable" });
      }
    },
  );
}
