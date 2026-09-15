import { randomUUID } from "node:crypto";
import {
  UnauthorizedError,
  validateStaffInviteAccess,
  validProductAccess,
  type CreateStaffInviteCommand,
  type RemoveStaffCommand,
  type UpdateStaffAccessCommand,
  type UpdateStaffStatusCommand,
  type TeamRoleCreateCommand,
  type TeamRoleChangeCommand,
  createPgStaffInvitationRepository,
  createPgTeamRoleRepository,
  createStaffInvitationDeliveryCoordinator,
  createStaffRemovalCoordinator,
} from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type StaffInvitationRepository = Pick<
  ReturnType<typeof createPgStaffInvitationRepository>,
  "getAccess" | "listRoster" | "persist" | "remove" | "updateAccess" | "updateStatus"
>;
type StaffInvitationDelivery = Pick<
  ReturnType<typeof createStaffInvitationDeliveryCoordinator>,
  "deliver"
>;
type StaffRemoval = Pick<ReturnType<typeof createStaffRemovalCoordinator>, "revoke">;

export type StaffInvitationRoutesOptions = {
  repository: StaffInvitationRepository;
  roles: Pick<ReturnType<typeof createPgTeamRoleRepository>, "list" | "create" | "change">;
  delivery: StaffInvitationDelivery;
  removal: StaffRemoval;
};

type StaffInvitationRequest = Omit<CreateStaffInviteCommand["payload"], "organizationId">;
type StaffAccessRequest = Omit<
  UpdateStaffAccessCommand["payload"],
  "organizationId" | "membershipId"
>;

const invitationBodyKeys = new Set([
  "roleDefinitionId",
  "expectedRoleRevision",
  "propertyAccessMode",
  "email",
  "name",
  "roleKey",
  "propertyIds",
  "permissionOverrides",
  "configurationRevision",
  "productAccess",
]);
const accessBodyKeys = new Set([
  "roleDefinitionId",
  "expectedRoleRevision",
  "propertyAccessMode",
  "roleKey",
  "propertyIds",
  "permissionOverrides",
  "expectedRevision",
  "membershipStatus",
  "productAccess",
]);

export async function registerStaffInvitationRoutes(
  app: FastifyInstance,
  options: StaffInvitationRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, ReturnType<typeof enforceRoutePolicy>>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const context = enforceRoutePolicy(request, { permission: "identity.staff.manage" });
      if (
        context.actor.status !== "active" ||
        context.selectedOrganization.kind !== "hotel_group" ||
        context.selectedOrganization.status !== "active" ||
        context.membership.status !== "active"
      ) {
        throw new AuthorizationError();
      }
      authorized.set(request, context);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return reply.status(401).send({ code: "unauthenticated" });
      }
      if (error instanceof AuthorizationError) {
        return reply.status(403).send({ code: "forbidden" });
      }
      throw error;
    }
  };

  app.get("/roles", { onRequest: authorize }, async (request, reply) => {
    const context = authorized.get(request);
    if (!context) throw new Error("Team role authorization was not resolved");
    reply.header("Cache-Control", "no-store");
    try {
      const roles = await options.roles.list(context.selectedOrganization.organizationId);
      return reply.send({ roles, canManageRoles: context.membership.roleKey === "hotel_owner" });
    } catch {
      return reply.status(500).send({ code: "team_roles_read_failed" });
    }
  });

  for (const method of ["POST", "PATCH", "DELETE"] as const) {
    app.route<{ Params: { roleId: string }; Body: unknown }>({
      method,
      url: method === "POST" ? "/roles" : "/roles/:roleId",
      onRequest: async (request, reply) => {
        await authorize(request, reply);
        const context = authorized.get(request);
        if (context && context.membership.roleKey !== "hotel_owner")
          return reply.status(403).send({ code: "forbidden" });
      },
      handler: async (request, reply) => {
        const context = authorized.get(request);
        if (!context) throw new Error("Team role authorization was not resolved");
        reply.header("Cache-Control", "no-store");
        const key = readIdempotencyKey(request);
        const body = parseRoleBody(request.body, method);
        if (!key || !body || (method !== "POST" && !roleUuid(request.params.roleId)))
          return reply.status(400).send({ code: "invalid_request" });
        const common = {
          commandId: randomUUID(),
          idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${key}`,
          audit: {
            actor: {
              kind: "user" as const,
              userId: context.actor.internalUserId,
              organizationId: context.selectedOrganization.organizationId,
            },
            source: context.audit.source,
            requestId: context.audit.requestId,
            correlationId: context.audit.correlationId,
            requestedAt: context.audit.receivedAt,
            reason: `${method === "POST" ? "Create" : method === "PATCH" ? "Update" : "Delete"} team role`,
          },
        };
        try {
          const result =
            method === "POST"
              ? await options.roles.create({
                  ...common,
                  payload: { organizationId: context.selectedOrganization.organizationId, ...body },
                } as TeamRoleCreateCommand)
              : await options.roles.change({
                  ...common,
                  payload: {
                    organizationId: context.selectedOrganization.organizationId,
                    roleId: request.params.roleId,
                    operation: method === "PATCH" ? "update" : "delete",
                    ...body,
                  },
                } as TeamRoleChangeCommand);
          if (result.outcome === "rejected") {
            const status =
              result.reason === "forbidden"
                ? 403
                : result.reason === "invalid_source_role"
                  ? 404
                  : ["invalid_command", "invalid_permissions"].includes(result.reason)
                    ? 400
                    : 409;
            return reply.status(status).send({ code: result.reason });
          }
          return reply.status(result.outcome === "created" ? 201 : 200).send(result);
        } catch {
          return reply.status(500).send({ code: "team_role_write_failed" });
        }
      },
    });
  }

  app.get("/members", { onRequest: authorize }, async (request, reply) => {
    const context = authorized.get(request);
    if (!context) throw new Error("Staff roster authorization was not resolved");
    try {
      const members = await options.repository.listRoster(
        context.selectedOrganization.organizationId,
      );
      return reply.send({ members });
    } catch {
      return reply.status(500).send({ code: "staff_roster_failed" });
    }
  });

  app.get<{ Params: { membershipId: string } }>(
    "/members/:membershipId/access",
    { onRequest: authorize },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) throw new Error("Staff access authorization was not resolved");
      reply.header("Cache-Control", "no-store");
      try {
        const access = await options.repository.getAccess(
          context.selectedOrganization.organizationId,
          request.params.membershipId,
        );
        if (!access) return reply.status(404).send({ code: "staff_member_not_found" });
        return reply.send(access);
      } catch {
        return reply.status(500).send({ code: "staff_access_read_failed" });
      }
    },
  );

  app.patch<{ Params: { membershipId: string }; Body: unknown }>(
    "/members/:membershipId",
    { onRequest: authorize },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) throw new Error("Staff access authorization was not resolved");
      const idempotencyKey = readIdempotencyKey(request);
      const body = parseStaffAccessRequest(request.body);
      if (!idempotencyKey || !body) return reply.status(400).send({ code: "invalid_request" });
      const command: UpdateStaffAccessCommand = {
        commandType: "identity.staff.access.update",
        commandId: randomUUID(),
        idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
        audit: {
          actor: {
            kind: "user",
            userId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
          },
          source: context.audit.source,
          requestId: context.audit.requestId,
          ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
          reason: "Update hotel staff access",
          requestedAt: context.audit.receivedAt,
        },
        payload: {
          organizationId: context.selectedOrganization.organizationId,
          membershipId: request.params.membershipId,
          ...body,
        },
      };
      try {
        const result = await options.repository.updateAccess(command);
        if (result.outcome === "rejected") return sendAccessUpdateRejection(reply, result.reason);
        return reply.send(result);
      } catch {
        return reply.status(500).send({ code: "staff_access_update_failed" });
      }
    },
  );

  app.patch<{ Params: { membershipId: string }; Body: unknown }>(
    "/members/:membershipId/status",
    { onRequest: authorize },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) throw new Error("Staff status authorization was not resolved");
      const idempotencyKey = readIdempotencyKey(request);
      const status = parseStaffStatusRequest(request.body);
      if (!idempotencyKey || !status) return reply.status(400).send({ code: "invalid_request" });
      const command: UpdateStaffStatusCommand = {
        commandType: "identity.staff.status.update",
        commandId: randomUUID(),
        idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
        audit: {
          actor: {
            kind: "user",
            userId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
          },
          source: context.audit.source,
          requestId: context.audit.requestId,
          ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
          reason:
            status === "deactivated"
              ? "Deactivate hotel staff member"
              : "Reactivate hotel staff member",
          requestedAt: context.audit.receivedAt,
        },
        payload: {
          organizationId: context.selectedOrganization.organizationId,
          membershipId: request.params.membershipId,
          membershipStatus: status === "deactivated" ? "suspended" : "active",
        },
      };
      try {
        const result = await options.repository.updateStatus(command);
        if (result.outcome === "rejected") return sendAccessUpdateRejection(reply, result.reason);
        return reply.send({
          outcome: result.outcome,
          membershipId: result.membershipId,
          status: result.membershipStatus === "suspended" ? "deactivated" : "active",
        });
      } catch {
        return reply.status(500).send({ code: "staff_status_update_failed" });
      }
    },
  );

  app.delete<{ Params: { membershipId: string } }>(
    "/members/:membershipId",
    { onRequest: authorize },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) throw new Error("Staff removal authorization was not resolved");
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return reply.status(400).send({ code: "invalid_request" });
      const command: RemoveStaffCommand = {
        commandType: "identity.staff.remove",
        commandId: randomUUID(),
        idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
        audit: {
          actor: {
            kind: "user",
            userId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
          },
          source: context.audit.source,
          requestId: context.audit.requestId,
          ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
          reason: "Remove hotel staff member",
          requestedAt: context.audit.receivedAt,
        },
        payload: {
          organizationId: context.selectedOrganization.organizationId,
          membershipId: request.params.membershipId,
        },
      };
      let result;
      try {
        result = await options.repository.remove(command);
      } catch {
        return reply.status(500).send({ code: "staff_removal_failed" });
      }
      if (result.outcome === "rejected") return sendAccessUpdateRejection(reply, result.reason);

      let providerStatus: "pending" | "reconciliation_required" | "revoked" = "pending";
      try {
        const revocation = await options.removal.revoke(result.providerRevocationJobId);
        providerStatus =
          revocation.outcome === "revoked"
            ? "revoked"
            : revocation.outcome === "reconciliation_required"
              ? "reconciliation_required"
              : "pending";
      } catch {
        // Internal access is already revoked atomically; the durable provider job remains retryable.
      }
      return reply.status(providerStatus === "revoked" ? 200 : 202).send({
        membershipId: result.membershipId,
        status: "removed",
        providerStatus,
      });
    },
  );

  app.post<{ Body: unknown }>("/invitations", { onRequest: authorize }, async (request, reply) => {
    const context = authorized.get(request);
    if (!context) throw new Error("Staff invitation authorization was not resolved");
    const idempotencyKey = readIdempotencyKey(request);
    const body = parseRequest(request.body);
    if (!idempotencyKey || !body) return reply.status(400).send({ code: "invalid_request" });

    const command: CreateStaffInviteCommand = {
      commandType: "identity.invite.staff.create",
      commandId: randomUUID(),
      idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
      audit: {
        actor: {
          kind: "user",
          userId: context.actor.internalUserId,
          organizationId: context.selectedOrganization.organizationId,
        },
        source: context.audit.source,
        requestId: context.audit.requestId,
        ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
        reason: "Invite hotel staff member",
        requestedAt: context.audit.receivedAt,
      },
      payload: {
        organizationId: context.selectedOrganization.organizationId,
        ...body,
      },
    };

    let result;
    try {
      result = await options.repository.persist(command);
    } catch {
      return reply.status(500).send({ code: "staff_invitation_failed" });
    }
    if (result.outcome === "rejected") return sendRejection(reply, result.reason);

    let delivery;
    try {
      delivery = await options.delivery.deliver(result.invitationId);
    } catch {
      return reply.status(500).send({ code: "staff_invitation_delivery_failed" });
    }
    return reply.status(result.outcome === "created" ? 201 : 200).send({
      outcome: result.outcome,
      invitationId: result.invitationId,
      delivery: delivery.outcome,
    });
  });
}

const roleUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function parseRoleBody(
  value: unknown,
  method: "POST" | "PATCH" | "DELETE",
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys =
    method === "DELETE"
      ? ["expectedRevision"]
      : method === "POST"
        ? ["name", "description", "defaultPermissions", "sourceRoleId"]
        : ["name", "description", "defaultPermissions", "expectedRevision"];
  if (Object.keys(body).some((key) => !keys.includes(key))) return null;
  if (
    method !== "POST" &&
    (typeof body.expectedRevision !== "string" || !/^[1-9][0-9]*$/.test(body.expectedRevision))
  )
    return null;
  if (
    method !== "DELETE" &&
    (typeof body.name !== "string" ||
      body.name.trim().length < 1 ||
      body.name.trim().length > 80 ||
      typeof body.description !== "string" ||
      body.description.length > 1000 ||
      !Array.isArray(body.defaultPermissions) ||
      !body.defaultPermissions.every((key) => typeof key === "string"))
  )
    return null;
  if (method === "POST" && body.sourceRoleId !== undefined && !roleUuid(body.sourceRoleId))
    return null;
  return body;
}

function parseRequest(value: unknown): StaffInvitationRequest | null {
  if (!plainRecord(value) || Object.keys(value).some((key) => !invitationBodyKeys.has(key)))
    return null;
  const email = typeof value["email"] === "string" ? value["email"].trim().toLowerCase() : "";
  const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
  const productAccess = value["productAccess"];
  const roleDefinitionId = value["roleDefinitionId"];
  const expectedRoleRevision = value["expectedRoleRevision"];
  const access = parseStaffAccess(value, roleDefinitionId !== undefined);
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    (value["name"] !== undefined && (!name || name.length > 200)) ||
    !access ||
    ((roleDefinitionId !== undefined || expectedRoleRevision !== undefined) &&
      (!roleUuid(roleDefinitionId) ||
        typeof expectedRoleRevision !== "string" ||
        !/^[1-9][0-9]*$/.test(expectedRoleRevision))) ||
    (productAccess !== undefined && !validProductAccess(productAccess)) ||
    !Number.isSafeInteger(value["configurationRevision"]) ||
    (value["configurationRevision"] as number) < 1 ||
    (value["configurationRevision"] as number) > 2_147_483_647
  ) {
    return null;
  }
  return {
    email,
    ...(name ? { name } : {}),
    ...access,
    configurationRevision: value["configurationRevision"] as number,
    ...(roleDefinitionId === undefined
      ? {}
      : {
          roleDefinitionId: roleDefinitionId as string,
          expectedRoleRevision: expectedRoleRevision as string,
        }),
    ...(productAccess === undefined
      ? {}
      : { productAccess: productAccess as { pms: boolean; booking: boolean } }),
  };
}

function parseStaffAccessRequest(value: unknown): StaffAccessRequest | null {
  if (!plainRecord(value) || Object.keys(value).some((key) => !accessBodyKeys.has(key)))
    return null;
  const access = parseStaffAccess(value, value["roleDefinitionId"] !== undefined);
  const roleDefinitionId = value["roleDefinitionId"];
  const expectedRoleRevision = value["expectedRoleRevision"];
  const expectedRevision = value["expectedRevision"];
  const membershipStatus = value["membershipStatus"];
  const productAccess = value["productAccess"];
  if (
    !access ||
    ((roleDefinitionId !== undefined || expectedRoleRevision !== undefined) &&
      (typeof roleDefinitionId !== "string" ||
        !roleUuid(roleDefinitionId) ||
        typeof expectedRoleRevision !== "string" ||
        !/^[1-9][0-9]*$/.test(expectedRoleRevision) ||
        expectedRevision === undefined)) ||
    (expectedRevision !== undefined &&
      (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) ||
    (membershipStatus !== undefined &&
      (expectedRevision === undefined ||
        (membershipStatus !== "active" && membershipStatus !== "suspended"))) ||
    (value["propertyAccessMode"] !== undefined && expectedRevision === undefined) ||
    (productAccess !== undefined &&
      (expectedRevision === undefined || !validProductAccess(productAccess)))
  )
    return null;
  return {
    ...access,
    ...(roleDefinitionId === undefined
      ? {}
      : {
          roleDefinitionId: roleDefinitionId as string,
          expectedRoleRevision: expectedRoleRevision as string,
        }),
    ...(productAccess === undefined
      ? {}
      : { productAccess: productAccess as { pms: boolean; booking: boolean } }),
    ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision as string }),
    ...(membershipStatus === undefined
      ? {}
      : { membershipStatus: membershipStatus as "active" | "suspended" }),
  };
}

function parseStaffStatusRequest(value: unknown): "active" | "deactivated" | null {
  if (!plainRecord(value) || Object.keys(value).length !== 1) return null;
  return value["status"] === "active" || value["status"] === "deactivated" ? value["status"] : null;
}

function parseStaffAccess(
  value: Record<string, unknown>,
  savedRole = false,
): StaffAccessRequest | null {
  const propertyIds = value["propertyIds"];
  const overrides = value["permissionOverrides"];
  if (
    typeof value["roleKey"] !== "string" ||
    !stringArray(propertyIds) ||
    !plainRecord(overrides) ||
    !stringArray(overrides["grant"]) ||
    !stringArray(overrides["deny"]) ||
    Object.keys(overrides).some((key) => key !== "grant" && key !== "deny")
  ) {
    return null;
  }
  const access = {
    roleKey: value["roleKey"],
    propertyAccessMode:
      value["propertyAccessMode"] === undefined ? "assigned" : value["propertyAccessMode"],
    propertyIds,
    permissionOverrides: { grant: overrides["grant"], deny: overrides["deny"] },
  };
  if (
    typeof access.propertyAccessMode !== "string" ||
    validateStaffInviteAccess({ ...access, propertyAccessMode: access.propertyAccessMode }).filter(
      (issue) => !savedRole || issue !== "missing_required_permission",
    ).length
  )
    return null;
  return {
    roleKey: access.roleKey as StaffAccessRequest["roleKey"],
    propertyAccessMode: access.propertyAccessMode as "assigned" | "all",
    propertyIds,
    permissionOverrides: access.permissionOverrides as StaffAccessRequest["permissionOverrides"],
  };
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sendRejection(reply: FastifyReply, reason: string) {
  if (reason === "inviter_not_authorized") {
    return reply.status(403).send({ code: "forbidden" });
  }
  if (reason === "property_scope_invalid") {
    return reply.status(404).send({ code: "staff_access_scope_not_found" });
  }
  if (reason === "idempotency_conflict" || reason === "configuration_conflict") {
    return reply.status(409).send({ code: "staff_invitation_conflict" });
  }
  return reply.status(400).send({ code: "invalid_request" });
}

function sendAccessUpdateRejection(reply: FastifyReply, reason: string) {
  if (reason === "revision_conflict")
    return reply.status(409).send({ code: "staff_access_revision_conflict" });
  if (reason === "inviter_not_authorized") return reply.status(403).send({ code: "forbidden" });
  if (reason === "target_not_found") {
    return reply.status(404).send({ code: "staff_member_not_found" });
  }
  if (reason === "property_scope_invalid") {
    return reply.status(404).send({ code: "staff_access_scope_not_found" });
  }
  if (reason === "idempotency_conflict") {
    return reply.status(409).send({ code: "staff_access_conflict" });
  }
  return reply.status(400).send({ code: "invalid_request" });
}
