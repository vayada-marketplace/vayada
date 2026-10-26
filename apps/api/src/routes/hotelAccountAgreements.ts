import { UnauthorizedError, requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
  isCurrentHotelAccountAgreements,
  type HotelAccountAgreementsStatus,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HotelAccountAgreementsRepository } from "../domains/hotelAccountAgreementsRepository.js";

/**
 * VAY-2246: the hotel account's contract with vayada, the hotel terms and their annex, the data
 * processing agreement, for Booking Admin and the PMS.
 *   GET  /api/hotel-account/agreements          everyone on the account: the current versions, their
 *                                                acceptance and whether the signed-in person may accept
 *   POST /api/hotel-account/agreements/accept   { termsVersion, dpaVersion }: the account admin accepts the
 *                                                current versions for the account (the banner and the
 *                                                Privacy & data card)
 */
export type HotelAccountAgreementsRouteOptions = {
  repository: HotelAccountAgreementsRepository;
};

function accountMember(request: FastifyRequest): RequestContext {
  const context = requireAuthContext(request);
  if (
    context.actor.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active" ||
    context.membership.status !== "active"
  )
    throw new AuthorizationError();
  return context;
}

const isAccountAdmin = (context: RequestContext) => context.membership.roleKey === "hotel_owner";

function sendAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof UnauthorizedError)
    return reply.status(401).send({ code: "unauthenticated" });
  if (error instanceof AuthorizationError) return reply.status(403).send({ code: "forbidden" });
  throw error;
}

export async function registerHotelAccountAgreementsRoutes(
  app: FastifyInstance,
  options: HotelAccountAgreementsRouteOptions,
) {
  async function status(context: RequestContext): Promise<HotelAccountAgreementsStatus> {
    return {
      current: { ...CURRENT_HOTEL_ACCOUNT_AGREEMENTS },
      accepted: await options.repository.findAcceptance(
        context.selectedOrganization.organizationId,
        CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
      ),
      canAccept: isAccountAdmin(context),
      accountName: context.selectedOrganization.name ?? null,
    };
  }

  app.get("/agreements", async (request, reply) => {
    let context: RequestContext;
    try {
      context = accountMember(request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
    reply.header("Cache-Control", "private, no-store");
    return reply.send(await status(context));
  });

  app.post("/agreements/accept", async (request, reply) => {
    let context: RequestContext;
    try {
      context = accountMember(request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
    if (!isAccountAdmin(context)) return reply.status(403).send({ code: "account_admin_required" });
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { termsVersion?: unknown }).termsVersion !== "string" ||
      typeof (body as { dpaVersion?: unknown }).dpaVersion !== "string"
    )
      return reply.status(400).send({ code: "invalid_agreements" });
    // The person accepts what the page showed them; a newer version needs reading first.
    if (!isCurrentHotelAccountAgreements(body))
      return reply
        .status(409)
        .send({ code: "agreements_outdated", current: CURRENT_HOTEL_ACCOUNT_AGREEMENTS });
    const accepted = await options.repository.accept({
      organizationId: context.selectedOrganization.organizationId,
      userId: context.actor.internalUserId,
      source: "account_admin",
      versions: CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
    });
    if (!accepted) return reply.status(403).send({ code: "account_admin_required" });
    reply.header("Cache-Control", "private, no-store");
    return reply.send(await status(context));
  });
}
