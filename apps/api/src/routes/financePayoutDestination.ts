import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { payoutDestinationDetailsSchema } from "../domains/financePayoutDestinationCodec.js";
import type {
  createPayoutDestinationRepository,
  PayoutDestinationSummary,
} from "../domains/financePayoutDestinationRepository.js";
import {
  enforceFinancePropertyReadPolicy,
  enforceFinancePropertyWritePolicy,
  type FinanceRoutesOptions,
} from "./finance.js";

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("replace"),
    commandId: z.uuid(),
    expectedVersion: z.int().nonnegative(),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    details: payoutDestinationDetailsSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    commandId: z.uuid(),
    expectedVersion: z.int().positive(),
  }),
]);
const path = "/finance/properties/:propertyId/payout-destination";
type Repository = Pick<ReturnType<typeof createPayoutDestinationRepository>, "read" | "execute">;

/** The bank account vayada Payment pays a hotel out to (VAY-2442). Registered only while
 * VAYADA_PAYMENT_ENABLED is on. Anyone with finance read access sees it masked; only the owner
 * (finance.billing.manage, VAY-2401) can add, replace or remove it. */
export async function registerFinancePayoutDestinationRoutes(
  app: FastifyInstance,
  options: {
    repository: Repository;
    propertyAccessRepository?: FinanceRoutesOptions["propertyAccessRepository"];
    publicBookabilityPublisher?: FinanceRoutesOptions["publicBookabilityPublisher"];
  },
) {
  for (const method of ["GET", "PUT"] as const) {
    app.route<{ Params: { propertyId: string }; Body: unknown }>({
      method,
      url: path,
      bodyLimit: 8192,
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const allowed =
          method === "GET"
            ? await enforceFinancePropertyReadPolicy(
                request,
                reply,
                request.params.propertyId,
                options.propertyAccessRepository,
              )
            : await enforceFinancePropertyWritePolicy(
                request,
                reply,
                request.params.propertyId,
                options.propertyAccessRepository,
                { ownerOnly: true },
              );
        if (!allowed) return reply;
      },
      async handler(request, reply) {
        const propertyId = request.params.propertyId;
        if (!z.uuid().safeParse(propertyId).success)
          return reply.code(400).send({ code: "invalid_request" });
        try {
          if (method === "GET")
            return { destination: masked(await options.repository.read(propertyId), propertyId) };
          const parsed = bodySchema.safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ code: "invalid_request" });
          const result = await options.repository.execute({
            ...parsed.data,
            propertyId,
            actorId: requireAuthContext(request).actor.internalUserId,
          });
          if (result.status === "conflict")
            return reply.code(409).send({ code: "destination_conflict" });
          await options.publicBookabilityPublisher?.publish({ propertyId });
          return { destination: masked(result.summary, propertyId) };
        } catch {
          return reply.code(503).send({ code: "payout_destination_unavailable" });
        }
      },
    });
  }
}

function masked(value: PayoutDestinationSummary | null, propertyId: string) {
  if (!value) return null;
  if (value.propertyId !== propertyId || !/^[A-Za-z0-9]{4}$/.test(value.accountLast4))
    throw new Error();
  return {
    id: value.id,
    revision: value.revision,
    version: value.version,
    enabled: value.enabled,
    deleted: value.deleted,
    countryCode: value.countryCode,
    maskedAccount: value.deleted ? null : `•••• ${value.accountLast4}`,
  };
}
