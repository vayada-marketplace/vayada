import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  parsePricingStorageSnapshot,
  PricingStorageError,
  type StoredPricingRevision,
} from "../domains/replacementPricingSnapshot.js";
import { planChannexOfferConfiguration } from "../integrations/channexOfferConfiguration.js";
import { enforceRoutePolicy } from "./policy.js";

export type ChannexOfferPreviewRoutesOptions = {
  /** Trusted server adapter: bounded acquisition/queries, shared decoder and source
   * freshness, both permissions and property authorization in the read transaction.
   * No worker lease, provider calls or writes.
   */
  read(
    context: RequestContext,
    propertyId: string,
  ): Promise<(StoredPricingRevision & { stale: boolean }) | null>;
};
const uuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const fields = ["roomTypeId", "offerId", "publicationRevision", "primaryOccupancy"];
const positive = (v: string, max: number) =>
  /^[1-9][0-9]*$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) <= max;

/** Protected preview adapter; enabled only with its trusted server reader. */
export async function registerChannexOfferPreviewRoutes(
  app: FastifyInstance,
  options: ChannexOfferPreviewRoutesOptions,
) {
  const authorized = new WeakMap<FastifyRequest, RequestContext>();
  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex/offer-preview",
    {
      async onRequest(request, reply) {
        reply.header("Cache-Control", "no-store");
        try {
          const base = enforceRoutePolicy(request, { permission: "pms.operations.read" });
          enforceRoutePolicy(request, { permission: "pms.rooms_rates.read" });
          if (base.selectedOrganization.kind !== "hotel_group")
            return reply.code(403).send({ code: "forbidden" });
          if (!uuid(request.params.propertyId)) return reply.code(400).send({ code: "invalid" });
          const resource = {
            product: "pms",
            resourceType: "pms_property",
            resourceId: request.params.propertyId,
          } as const;
          authorized.set(
            request,
            enforceRoutePolicy(request, {
              permission: "pms.rooms_rates.read",
              entitlement: { product: "pms", key: "property-management", resource },
              resource: { ...resource, allowedRelationships: ["owner", "operator"] },
            }),
          );
        } catch (error) {
          if (error instanceof UnauthorizedError)
            return reply.code(401).send({ code: "unauthenticated" });
          if (error instanceof AuthorizationError)
            return reply.code(403).send({ code: "forbidden" });
          throw error;
        }
      },
    },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) return reply.code(401).send({ code: "unauthenticated" });
      // Parse raw query to preserve duplicate fields, independently of server parser options.
      const query = new URLSearchParams((request.raw.url ?? "").split("?").slice(1).join("?"));
      if (
        [...query.keys()].length !== fields.length ||
        fields.some((key) => query.getAll(key).length !== 1) ||
        [...query.keys()].some((key) => !fields.includes(key))
      )
        return reply.code(400).send({ code: "invalid" });
      const roomTypeId = query.get("roomTypeId")!,
        offerId = query.get("offerId")!;
      const revision = query.get("publicationRevision")!,
        primary = query.get("primaryOccupancy")!;
      if (
        !uuid(roomTypeId) ||
        !offerId ||
        offerId.trim() !== offerId ||
        offerId.length > 200 ||
        !positive(revision, 2147483647) ||
        !positive(primary, 100)
      )
        return reply.code(400).send({ code: "invalid" });
      const propertyId = request.params.propertyId,
        publicationRevision = Number(revision),
        primaryOccupancy = Number(primary);
      try {
        const stored = await options.read(context, propertyId);
        if (stored === null) return reply.code(404).send({ code: "not_found" });
        if (
          !Number.isSafeInteger(stored.revision) ||
          stored.revision < 1 ||
          stored.revision > 2147483647 ||
          typeof stored.stale !== "boolean"
        )
          throw new Error("Invalid stored publication");
        const snapshot = parsePricingStorageSnapshot(
          {
            currency: stored.currency,
            rooms: stored.rooms,
            ownerReferences: stored.ownerReferences,
          },
          propertyId,
          stored.revision,
        );
        if (stored.stale || stored.revision !== publicationRevision)
          return reply.code(409).send({ code: "refresh_required" });
        const room = snapshot.rooms.find((room) => room.roomTypeId === roomTypeId);
        if (!room || !room.offers.some((offer) => offer.id === offerId))
          return reply.code(404).send({ code: "not_found" });
        if (primaryOccupancy > room.capacity.adults)
          return reply.code(400).send({ code: "invalid" });
        const plan = planChannexOfferConfiguration(room, offerId, primaryOccupancy);
        const selection = {
          schemaVersion: 1,
          propertyId,
          roomTypeId,
          offerId,
          publicationRevision,
          primaryOccupancy,
          canProvision: false,
          canSend: false,
        };
        if (plan.kind === "unavailable") {
          if (!["child_representation_unavailable", "candidate_limit"].includes(plan.reason))
            throw new Error("Invalid preview");
          return reply.send({ ...selection, kind: "unsupported", reason: plan.reason });
        }
        return reply.send({ ...selection, kind: "preview", configuration: plan.configuration });
      } catch (error) {
        if (error instanceof PricingStorageError && error.code === "denied")
          return reply.code(403).send({ code: "forbidden" });
        if (error instanceof PricingStorageError && error.code === "stale")
          return reply.code(409).send({ code: "refresh_required" });
        return reply.code(503).send({ code: "pricing_unavailable" });
      }
    },
  );
}
