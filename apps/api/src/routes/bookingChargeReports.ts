import {
  AuthError,
  AuthorizationResolutionError,
  UnauthorizedError,
  type RequestContext,
} from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { submitBookingChargeReport } from "../domains/bookingChargeReport.js";
import { enforceRoutePolicy } from "./policy.js";

type Input = Parameters<typeof submitBookingChargeReport>[1];
type Params = Pick<Input, "propertyId" | "bookingId">;
export type BookingChargeReportRoutesOptions = {
  submit(
    input: Input,
    freshContext: () => Promise<RequestContext>,
  ): ReturnType<typeof submitBookingChargeReport>;
  refreshContext(request: FastifyRequest): Promise<RequestContext>;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function authorize(request: FastifyRequest) {
  const context = enforceRoutePolicy(request, { permission: "booking.settings.manage" });
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group"
  )
    throw new AuthorizationError();
  const params = request.params as Params;
  if (!uuid(params.propertyId) || !uuid(params.bookingId))
    throw Object.assign(new Error("Canonical property and booking IDs required"), {
      statusCode: 422,
    });
  params.propertyId = params.propertyId.toLowerCase();
  params.bookingId = params.bookingId.toLowerCase();
  const resource = {
    product: "booking" as const,
    resourceType: "booking_hotel" as const,
    resourceId: params.propertyId,
  };
  return enforceRoutePolicy(request, {
    permission: "booking.settings.manage",
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
    entitlement: { product: "booking", key: "booking-engine", resource },
  });
}

/** Composition must provide real auth re-resolution and the server-configured command.
 * Never construct runtime source/purpose from request fields or reuse a cached context.
 */
export async function registerBookingChargeReportRoutes(
  app: FastifyInstance,
  options: BookingChargeReportRoutesOptions,
) {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    authorize(request);
  });
  app.post<{ Params: Params; Body: unknown }>(
    "/properties/:propertyId/bookings/:bookingId/charge-reports",
    async (request, reply) => {
      const initial = authorize(request),
        body = request.body,
        key = request.headers["idempotency-key"];
      const actorId = initial.actor.internalUserId,
        organizationId = initial.selectedOrganization.organizationId;
      const keyCount = request.raw.rawHeaders.filter(
        (v, i) => i % 2 === 0 && v.toLowerCase() === "idempotency-key",
      ).length;
      if (
        typeof key !== "string" ||
        !key ||
        key !== key.trim() ||
        key.length > 200 ||
        key.includes(",") ||
        keyCount !== 1 ||
        !record(body) ||
        Object.keys(body).sort().join(",") !==
          "components,expectedReportId,reportedItemReference" ||
        !(body.expectedReportId === null || uuid(body.expectedReportId)) ||
        typeof body.reportedItemReference !== "string" ||
        !record(body.components) ||
        Object.keys(body.components).sort().join(",") !== "accommodation,extras,other,tax" ||
        !Object.values(body.components).every((v) => typeof v === "string")
      )
        return reply.code(422).send({ code: "invalid_request" });
      try {
        const result = await options.submit(
          {
            ...request.params,
            sourceRevision: key,
            expectedReportId: body.expectedReportId,
            reportedItemReference: body.reportedItemReference,
            components: body.components as Input["components"],
          },
          async () => {
            const fresh = await options.refreshContext(request);
            if (
              fresh.actor.internalUserId !== actorId ||
              fresh.selectedOrganization.organizationId !== organizationId
            )
              throw new AuthorizationError();
            request.authContext = fresh;
            return authorize(request);
          },
        );
        const status = result.ok
          ? result.replayed
            ? 200
            : 201
          : {
              invalid_request: 422,
              scope_unavailable: 404,
              source_unavailable: 409,
              revision_conflict: 409,
              idempotency_conflict: 409,
            }[result.code];
        return reply.code(status).send(result);
      } catch (error) {
        if (error instanceof AuthError || error instanceof UnauthorizedError)
          return reply.code(401).send({ code: "unauthorized" });
        if (error instanceof AuthorizationError || error instanceof AuthorizationResolutionError)
          return reply.code(403).send({ code: "forbidden" });
        request.log.error({ err: error }, "Charge report submission failed");
        return reply.code(500).send({ code: "submission_unavailable" });
      }
    },
  );
}
