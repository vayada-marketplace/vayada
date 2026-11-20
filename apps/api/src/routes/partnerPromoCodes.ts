import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PartnerAccess } from "../domains/partnerConnections.js";
import type { PartnerPromoCodesRepository } from "../domains/partnerPromoCodes.js";
import {
  BookingPromoCodeAmountError,
  isInvalidTargetPayloadError,
  isUniqueViolation,
  parseCreateBody,
  parseUpdateBody,
  validateEffectiveUpdate,
} from "./bookingPromoCodes.js";

/**
 * VAY-2437: a connected partner app's own promo codes at the hotel its token works for (contract
 * "What Vayada accepts and sends", section 2). Same fields and checks as the hotel's own
 * /api/booking/hotels/:hotelId/promo-codes, plus the partner's externalId. Needs the promo_codes scope.
 *
 *   GET    /partner/v1/promo-codes                  { promoCodes } this app's codes, retired ones too
 *   POST   /partner/v1/promo-codes                  201 with the code; 409 conflict on a clash
 *   PATCH  /partner/v1/promo-codes/:promoCodeId     discount, limits, isActive or externalId; never code
 *   DELETE /partner/v1/promo-codes/:promoCodeId     204, retires it (twice is fine)
 */
type Fail = (
  reply: FastifyReply,
  status: number,
  code: "invalid_payload" | "unauthenticated" | "forbidden" | "not_found" | "conflict",
  message: string,
  details?: string[],
) => FastifyReply;

type Params = { promoCodeId: string };

export function registerPartnerPromoCodeRoutes(
  app: FastifyInstance,
  options: {
    repository: PartnerPromoCodesRepository;
    accessOf: (request: FastifyRequest) => PartnerAccess;
    fail: Fail;
  },
) {
  const { repository, fail } = options;
  /** The app and hotel of a token with the promo_codes scope, else null after a 403. */
  const scopeOf = (request: FastifyRequest, reply: FastifyReply) => {
    const access = options.accessOf(request);
    if (access.scopes.includes("promo_codes"))
      return {
        appId: access.appId,
        propertyId: access.propertyId,
        connectionId: access.connectionId,
      };
    fail(reply, 403, "forbidden", "This connection may not manage promo codes.");
    return null;
  };
  const invalid = (reply: FastifyReply, details: string[]) =>
    fail(reply, 422, "invalid_payload", "The promo code is not valid.", details);
  const writeError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof BookingPromoCodeAmountError) return invalid(reply, [error.message]);
    if (isUniqueViolation(error))
      return fail(reply, 409, "conflict", "The hotel already has an active code with this text.");
    if (isInvalidTargetPayloadError(error))
      return invalid(reply, ["The promo code doesn't fit the hotel's limits."]);
    throw error;
  };

  app.get("/promo-codes", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return reply;
    return reply.header("Cache-Control", "private, no-store").send({
      promoCodes: await repository.list(scope),
    });
  });

  app.post("/promo-codes", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return reply;
    const split = splitExternalId(request.body);
    if (!split.ok) return invalid(reply, split.details);
    const parsed = parseCreateBody(split.rest);
    if (!parsed.ok) return invalid(reply, parsed.details);
    try {
      const created = await repository.create(scope, {
        ...parsed.value,
        externalId: split.externalId ?? null,
      });
      if (!created)
        return fail(reply, 401, "unauthenticated", "This connection is no longer active.");
      return reply.status(201).send(created);
    } catch (error) {
      return writeError(reply, error);
    }
  });

  app.patch<{ Params: Params }>("/promo-codes/:promoCodeId", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return reply;
    const split = splitExternalId(request.body);
    if (!split.ok) return invalid(reply, split.details);
    if ("code" in split.rest)
      return invalid(reply, ["code can't change: retire the code and make a new one."]);
    const onlyExternalId = Object.keys(split.rest).length === 0 && split.externalId !== undefined;
    const parsed = onlyExternalId ? { ok: true as const, value: {} } : parseUpdateBody(split.rest);
    if (!parsed.ok) return invalid(reply, parsed.details);

    const current = await repository.find(scope, request.params.promoCodeId);
    if (!current) return fail(reply, 404, "not_found", "There is no such promo code.");
    if (current.status === "retired")
      return fail(reply, 409, "conflict", "The code is retired. Make a new one instead.");
    const details = validateEffectiveUpdate(current, parsed.value);
    if (details.length > 0) return invalid(reply, details);
    try {
      const updated = await repository.update(scope, current.promoCodeId, {
        ...parsed.value,
        ...(split.externalId !== undefined ? { externalId: split.externalId } : {}),
      });
      if (!updated)
        return fail(reply, 409, "conflict", "The code is retired. Make a new one instead.");
      return reply.send(updated);
    } catch (error) {
      return writeError(reply, error);
    }
  });

  app.delete<{ Params: Params }>("/promo-codes/:promoCodeId", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return reply;
    const result = await repository.retire(scope, request.params.promoCodeId);
    if (result === "not_found")
      return fail(reply, 404, "not_found", "There is no such promo code.");
    return reply.status(204).send();
  });
}

/** The partner's own id for the code: a string of 1 to 200 characters, or null to clear it. */
function splitExternalId(
  body: unknown,
):
  | { ok: true; externalId: string | null | undefined; rest: Record<string, unknown> }
  | { ok: false; details: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, details: ["Body must be an object."] };
  const { externalId, ...rest } = body as Record<string, unknown>;
  if (externalId === undefined || externalId === null) return { ok: true, externalId, rest };
  if (
    typeof externalId !== "string" ||
    externalId.length < 1 ||
    externalId.length > 200 ||
    externalId.includes("\u0000")
  )
    return { ok: false, details: ["externalId must be a string of 1 to 200 characters."] };
  return { ok: true, externalId, rest };
}
