import { createHash } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import {
  hasActiveEntitlement,
  hasActiveLinkedResource,
  hasPermission,
} from "@vayada/backend-authorization";
import {
  IMPORT_PROPERTY_FIELDS,
  parsePreparedHotelImport,
  type ImportItemResult,
  type PreparedRoom,
  type PropertyProfile,
} from "@vayada/domain-hotels";
import { parseDraftRoomId, parseRoomTypeFacts, type RoomTypeFacts } from "@vayada/domain-pms";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  PreparedImportRepository,
  ImportScope,
} from "../domains/preparedHotelImportRepository.js";
import type { PmsRoomFactsRoutesOptions } from "./pmsRoomFacts.js";
import {
  parseCanonicalPropertyProfile,
  type SharedHotelSetupStatusRepository,
} from "./sharedHotelSetupStatus.js";
import { enforceRoutePolicy } from "./policy.js";

export type PreparedHotelImportRoutesOptions = {
  repository: PreparedImportRepository;
  profiles: Pick<SharedHotelSetupStatusRepository, "getPropertyProfile" | "updatePropertyProfile">;
  rooms?: PmsRoomFactsRoutesOptions;
};

export async function registerPreparedHotelImportRoutes(
  app: FastifyInstance,
  options: PreparedHotelImportRoutesOptions,
) {
  const access = new WeakMap<FastifyRequest, RequestContext>();
  app.addHook("onRequest", async (request, reply) => {
    const propertyId = (request.params as { propertyId?: string }).propertyId;
    const context = enforceRoutePolicy(request, {
      permission: "hotel_catalog.setup.manage",
      ...(propertyId
        ? {
            resource: {
              product: "hotel_catalog" as const,
              resourceType: "property" as const,
              resourceId: propertyId,
              allowedRelationships: ["owner", "operator"],
            },
          }
        : {}),
    });
    if (
      context.actor.status !== "active" ||
      context.membership.status !== "active" ||
      context.selectedOrganization.kind !== "hotel_group" ||
      context.selectedOrganization.status !== "active"
    ) {
      return reply.status(403).send({ code: "invalid_organization_scope" });
    }
    access.set(request, context);
    reply.header("Cache-Control", "private, no-store");
  });
  app.addHook("onClose", async () => options.repository.close());
  const scope = (request: FastifyRequest): ImportScope => {
    const context = access.get(request)!;
    return {
      organizationId: context.selectedOrganization.organizationId,
      actorUserId: context.actor.internalUserId,
    };
  };

  app.get("/imports/prepared", async (request) => ({
    import: await options.repository.find(scope(request)),
  }));

  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/import",
    async (request, reply) => {
      const actor = scope(request);
      const propertyId = request.params.propertyId;
      const source = await options.repository.find(actor);
      if (!source) return { import: null };
      if (source.propertyId && source.propertyId !== propertyId)
        return reply.status(409).send({ code: "import_property_conflict" });
      const profile = await options.profiles.getPropertyProfile({ ...actor, propertyId });
      if (!profile) return reply.status(404).send({ code: "property_not_found" });
      const canImportRooms = !!options.rooms && roomAccess(access.get(request)!, propertyId);
      const rooms = canImportRooms
        ? await options.rooms!.factsReadPort.listRoomTypeFacts(propertyId)
        : [];
      return {
        import: source,
        profile,
        canImportRooms,
        canImportProperty: profileAccess(access.get(request)!),
        existingRooms: rooms
          .filter((room) => room.lifecycle === "active")
          .map((room) => ({ id: room.roomTypeId, name: room.facts.name })),
      };
    },
  );

  app.post<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/import",
    { bodyLimit: 300_000 },
    async (request, reply) => {
      const body = request.body;
      if (
        !isRecord(body) ||
        !Object.keys(body).every((key) =>
          ["sourceId", "data", "expectedProfileRevision"].includes(key),
        ) ||
        typeof body.sourceId !== "string"
      )
        return reply.status(422).send({ code: "invalid_import" });
      const data = parsePreparedHotelImport(body.data);
      if (!data || (!data.rooms.length && !Object.keys(data.property).length))
        return reply.status(422).send({ code: "invalid_import" });
      const context = access.get(request)!;
      const actor = scope(request);
      const propertyId = request.params.propertyId;
      if (data.rooms.length && (!options.rooms || !roomAccess(context, propertyId)))
        return reply.status(403).send({ code: "missing_room_import_access" });
      if (
        Object.keys(data.property).length &&
        (!profileAccess(context) || !Number.isSafeInteger(body.expectedProfileRevision))
      ) {
        return reply.status(403).send({ code: "missing_property_import_access" });
      }
      const facts = new Map<string, RoomTypeFacts>();
      for (const room of data.rooms) {
        const parsed = roomFacts(room);
        if (!parsed)
          return reply.status(422).send({ code: "incomplete_room_facts", itemId: room.id });
        facts.set(room.id, parsed);
      }
      try {
        const items = await options.repository.apply(
          { ...actor, sourceId: body.sourceId, propertyId },
          async (source) => {
            if (
              data.rooms.some(
                (room) => !source.data.rooms.some((candidate) => candidate.id === room.id),
              )
            )
              throw new Error("import_not_available");
            const results: ImportItemResult[] = [];
            if (Object.keys(data.property).length) {
              const pendingFields = Object.fromEntries(
                Object.entries(data.property).filter(
                  ([field]) => !source.results[`property:${field}`],
                ),
              );
              for (const field of Object.keys(data.property)) {
                const saved = source.results[`property:${field}`];
                if (saved) results.push(saved);
              }
              const pendingIds = Object.keys(pendingFields).map((field) => `property:${field}`);
              if (pendingIds.length) {
                try {
                  const current = await options.profiles.getPropertyProfile({
                    ...actor,
                    propertyId,
                  });
                  if (!current) throw new Error("property_not_found");
                  const profile = mergeImportProperty(current.profile, pendingFields);
                  const errors: Record<string, string[]> = {};
                  const validated = parseCanonicalPropertyProfile(profile, errors);
                  if (!validated || Object.keys(errors).length)
                    throw new Error("incomplete_property_details");
                  // A lost response may follow a committed profile write. Comparing
                  // all fields allows recovery without overwriting subsequent edits.
                  if (JSON.stringify(current.profile) !== JSON.stringify(validated)) {
                    const saved = await options.profiles.updatePropertyProfile({
                      ...actor,
                      propertyId,
                      expectedProfileRevision: body.expectedProfileRevision as number,
                      profile: validated,
                    });
                    if (!saved) throw new Error("profile_revision_conflict");
                  }
                  for (const itemId of pendingIds)
                    results.push({ itemId, status: "applied", resourceId: propertyId });
                } catch (error) {
                  const code =
                    error instanceof Error &&
                    [
                      "property_not_found",
                      "incomplete_property_details",
                      "profile_revision_conflict",
                    ].includes(error.message)
                      ? error.message
                      : "property_import_failed";
                  for (const itemId of pendingIds)
                    results.push({ itemId, status: "failed", error: code });
                }
              }
            }
            for (const room of data.rooms) {
              const itemId = `room:${room.id}`;
              if (source.results[itemId]) {
                results.push(source.results[itemId]);
                continue;
              }
              try {
                const draftRoomId = parseDraftRoomId(`import:${source.sourceId}:${room.id}`)!;
                const bound = await options.rooms!.bindingReadPort.getDraftRoomTypeBinding(
                  propertyId,
                  draftRoomId,
                );
                if (bound) {
                  // Do not overwrite a room edited after its original import.
                  results.push({ itemId, status: "applied", resourceId: bound.roomTypeId });
                  continue;
                }
                const result = await options.rooms!.commandPort.createRoomTypeFacts({
                  ...actor,
                  propertyId,
                  draftRoomId,
                  expectedRevision: 0,
                  facts: facts.get(room.id)!,
                  idempotencyKey: `prepared-room:${createHash("sha256")
                    .update(JSON.stringify([source.sourceId, room.id, facts.get(room.id)]))
                    .digest("hex")}`,
                  audit: {
                    actor: { kind: "user", userId: actor.actorUserId },
                    requestId: request.id,
                    correlationId: `prepared-import:${source.sourceId}`,
                    requestedAt: new Date().toISOString(),
                  },
                });
                results.push(
                  result.ok
                    ? { itemId, status: "applied", resourceId: result.response.roomType.roomTypeId }
                    : { itemId, status: "failed", error: result.error.code },
                );
              } catch {
                results.push({ itemId, status: "failed", error: "room_import_failed" });
              }
            }
            return results;
          },
        );
        return { items };
      } catch (error) {
        if (error instanceof Error && error.message === "import_not_available")
          return reply.status(404).send({ code: error.message });
        if (error instanceof Error && error.message === "import_property_conflict")
          return reply.status(409).send({ code: error.message });
        request.log.error({ err: error }, "Prepared import failed");
        return reply.status(503).send({ code: "import_temporarily_unavailable" });
      }
    },
  );
}

export function mergeImportProperty(
  profile: PropertyProfile,
  fields: Record<string, string>,
): PropertyProfile {
  const location = { ...profile.location };
  let addressChanged = false;
  for (const key of IMPORT_PROPERTY_FIELDS) {
    if (key === "displayName" || key === "propertyType" || fields[key] === undefined) continue;
    if (location[key] !== fields[key]) addressChanged = true;
    location[key] = fields[key];
  }
  if (addressChanged) {
    location.latitude = null;
    location.longitude = null;
    location.geoPublic = false;
    location.mapDisplayMode = "hidden";
  }
  return {
    ...profile,
    displayName: fields.displayName ?? profile.displayName,
    propertyType: fields.propertyType ?? profile.propertyType,
    location,
  };
}

function profileAccess(context: RequestContext) {
  return (
    hasPermission(context, "marketplace.profile.manage") ||
    hasPermission(context, "booking.settings.manage")
  );
}
function roomAccess(context: RequestContext, propertyId: string) {
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
  } as const;
  return (
    hasPermission(context, "pms.operations.manage") &&
    hasActiveLinkedResource(context, {
      ...resource,
      allowedRelationships: ["owner", "operator"],
    }) &&
    hasActiveEntitlement(context, { product: "pms", key: "property-management", resource })
  );
}
export function roomFacts(room: PreparedRoom): RoomTypeFacts | null {
  return parseRoomTypeFacts({
    name: room.name.trim(),
    description: room.description,
    category: null,
    occupancy: {
      maxGuests: room.maxGuests,
      maxAdults: room.maxAdults,
      maxChildren: room.maxChildren,
    },
    beds:
      room.bedType && room.bedQuantity ? [{ type: room.bedType, quantity: room.bedQuantity }] : [],
    bedrooms: null,
    bathrooms: null,
    bathroomType: room.bathroomType,
    size: room.sizeSquareMetres === null ? null : { value: room.sizeSquareMetres, unit: "sqm" },
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
