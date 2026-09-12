import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";
import type { PreparedHotelImport } from "@vayada/domain-hotels";
import type { createPgAirbnbImportSourceRepository } from "../domains/airbnbImportSourceRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type Repository = ReturnType<typeof createPgAirbnbImportSourceRepository>;
type Scope = Parameters<Repository["begin"]>[0];
type Binding = Parameters<Repository["begin"]>[1];
export type AirbnbImportRoutesOptions = {
  repository: Repository;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins: string[];
  resolveBinding(scope: Scope): Promise<Binding | null>;
  createLink(
    binding: Binding,
    attempt: { state: string; sourceId: string; propertyId: string },
  ): Promise<string>;
  readListings(binding: Binding, channelId: string): Promise<PreparedHotelImport>;
};
const completion = z.strictObject({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  channelId: z.uuid(),
});
const sameBinding = (a: Binding, b: Binding | null) =>
  b !== null &&
  a.environment === b.environment &&
  a.groupId === b.groupId &&
  a.externalPropertyId === b.externalPropertyId;

/** Opt-in plugin. Production binding/link ports and callback UI must be wired before mounting. */
export async function registerAirbnbImportRoutes(
  app: FastifyInstance,
  options: AirbnbImportRoutesOptions,
) {
  const scopes = new WeakMap<FastifyRequest, Scope>();
  app.addHook("onClose", async () => options.repository.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const propertyId = (request.params as { propertyId: string }).propertyId;
    const context = enforceRoutePolicy(request, {
      permission: "hotel_catalog.setup.manage",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator"],
      },
    });
    await enforcePmsPropertyRoutePolicy(
      request,
      { propertyId, permission: "pms.operations.manage" },
      options.propertyAccessRepository,
    );
    if (
      context.actor.status !== "active" ||
      context.membership.status !== "active" ||
      context.selectedOrganization.status !== "active" ||
      context.selectedOrganization.kind !== "hotel_group"
    )
      return reply.code(403).send({ code: "invalid_import_scope" });
    if (!z.uuid().safeParse(propertyId).success)
      return reply.code(400).send({ code: "invalid_property_id" });
    if (
      request.method !== "GET" &&
      (!request.headers.origin || !options.allowedOrigins.includes(request.headers.origin))
    )
      return reply.code(403).send({ code: "invalid_origin" });
    scopes.set(request, {
      propertyId,
      organizationId: context.selectedOrganization.organizationId,
      actorUserId: context.actor.internalUserId,
    });
  });
  const path = "/properties/:propertyId/airbnb-import";
  app.post(path + "/start", { bodyLimit: 2048 }, async (request, reply) => {
    if (!z.strictObject({}).safeParse(request.body).success)
      return reply.code(400).send({ code: "invalid_import_request" });
    try {
      const scope = scopes.get(request)!;
      const binding = await options.resolveBinding(scope);
      if (!binding) return reply.code(409).send({ code: "channex_binding_required" });
      const attempt = await options.repository.begin(scope, binding);
      const url = await options.createLink(binding, { ...attempt, propertyId: scope.propertyId });
      return { sourceId: attempt.sourceId, url };
    } catch {
      return reply.code(502).send({ code: "airbnb_connection_unavailable" });
    }
  });
  app.post(path + "/complete", { bodyLimit: 2048 }, async (request, reply) => {
    const parsed = completion.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "invalid_import_callback" });
    const { state, channelId } = parsed.data;
    try {
      const scope = scopes.get(request)!;
      const pending = await options.repository.pending(scope, state);
      if (!pending) return reply.code(409).send({ code: "import_attempt_unavailable" });
      if (!sameBinding(pending, await options.resolveBinding(scope)))
        return reply.code(409).send({ code: "channex_binding_changed" });
      const data = await options.readListings(pending, channelId);
      if (!sameBinding(pending, await options.resolveBinding(scope)))
        return reply.code(409).send({ code: "channex_binding_changed" });
      const sourceId = await options.repository.complete(scope, state, channelId, data);
      return sourceId ? { sourceId } : reply.code(409).send({ code: "import_attempt_unavailable" });
    } catch (error) {
      if (error instanceof Error && error.message === "airbnb_source_already_bound")
        return reply.code(409).send({ code: "airbnb_source_already_bound" });
      return reply.code(502).send({ code: "airbnb_source_unavailable" });
    }
  });
  app.get<{ Params: { sourceId: string } }>(path + "/sources/:sourceId", async (request, reply) => {
    if (!z.uuid().safeParse(request.params.sourceId).success)
      return reply.code(400).send({ code: "invalid_source_id" });
    try {
      const scope = scopes.get(request)!;
      const source = await options.repository.find(scope, request.params.sourceId);
      if (!source) return reply.code(404).send({ code: "import_source_not_found" });
      if (!sameBinding(source, await options.resolveBinding(scope)))
        return reply.code(409).send({ code: "channex_binding_changed" });
      return { sourceId: source.sourceId, data: source.data };
    } catch {
      return reply.code(502).send({ code: "airbnb_source_unavailable" });
    }
  });
}
