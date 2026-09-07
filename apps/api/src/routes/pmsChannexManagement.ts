import { stayRestrictionReplacement } from "../domains/pmsStayRestrictions.js";
import {
  NoShowReportingConflict,
  type NoShowReportingStore,
} from "../domains/pmsNoShowReporting.js";
import {
  CHANNEX_MANAGEMENT_OPERATION_TYPES,
  type ChannexManagementCapabilityModes,
  type ChannexManagementOperationType,
} from "@vayada/domain-pms-channex";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChannelDatePricesPort } from "../domains/pmsChannelDatePrices.js";

import type { PmsChannexManagementCommandPort } from "../domains/pmsChannexManagementCommands.js";
import type { PmsChannexIframeSessionPort } from "../domains/pmsChannexIframeSession.js";
import type { PmsChannexManagementReadRepository } from "../domains/pmsChannexManagementReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export type PmsChannexManagementRoutesOptions = {
  repository: PmsChannexManagementReadRepository;
  noShowReports?: NoShowReportingStore;
  noShowReportingEnabled?: boolean;
  capabilityModes: ChannexManagementCapabilityModes;
  commandPort?: PmsChannexManagementCommandPort;
  iframeSessionPort?: PmsChannexIframeSessionPort;
  datePrices?: ChannelDatePricesPort;
};

export async function registerPmsChannexManagementRoutes(
  app: FastifyInstance,
  options: PmsChannexManagementRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.repository.close?.();
    await options.commandPort?.close?.();
    await options.iframeSessionPort?.close?.();
    await options.datePrices?.close();
  });

  const dateScope = z.object({
    propertyId: z.uuid(),
    roomTypeId: z.uuid(),
    ratePlanId: z.uuid(),
    stayDate: z.iso.date(),
  });
  const dateBody = z.strictObject({
    commandId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    amountDecimal: z
      .string()
      .regex(/^(0|[1-9]\d{0,12})\.\d{2}$/)
      .refine((value) => Number(value) > 0)
      .nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  });
  const datePath =
    "/properties/:propertyId/channex/room-types/:roomTypeId/rate-plans/:ratePlanId/date-prices/:stayDate";
  app.get<{ Params: { propertyId: string } }>(datePath, async (request, reply) => {
    enforcePmsChannexPolicy(request, request.params.propertyId, "pms.operations.read");
    const scope = dateScope.safeParse(request.params);
    if (!scope.success) return reply.code(400).send({ code: "invalid_date_price" });
    if (!options.datePrices) return reply.code(503).send({ code: "date_prices_unavailable" });
    return (
      (await options.datePrices.get(scope.data)) ??
      reply.code(404).send({ code: "date_price_not_found" })
    );
  });
  app.put<{ Params: { propertyId: string }; Body: unknown }>(datePath, async (request, reply) => {
    const context = enforcePmsChannexPolicy(
      request,
      request.params.propertyId,
      "pms.operations.manage",
    );
    const scope = dateScope.safeParse(request.params);
    const body = dateBody.safeParse(request.body);
    if (!scope.success || !body.success)
      return reply.code(400).send({ code: "invalid_date_price" });
    if (options.capabilityModes.ariSync !== "mutating")
      return reply.code(409).send({ code: "channex_capability_not_mutating" });
    if (!options.datePrices) return reply.code(503).send({ code: "date_prices_unavailable" });
    return (
      (await options.datePrices.put(context, { ...scope.data, ...body.data })) ??
      reply
        .code(409)
        .send({
          code: "date_price_conflict",
          message: "Refresh the date price and canonical rate plan before retrying.",
        })
    );
  });

  const reportPath = "/properties/:propertyId/reservations/:bookingId/no-show-report";
  type ReportParams = { propertyId: string; bookingId: string };
  app.get<{ Params: ReportParams }>(reportPath, async (request, reply) => {
    const { propertyId, bookingId } = request.params;
    enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
    if (!options.noShowReports)
      return reply.code(503).send({ message: "Reporting is unavailable." });
    const result = await options.noShowReports.get(propertyId, bookingId);
    if (!result) return reply.code(404).send({ message: "Reservation not found." });
    return options.noShowReportingEnabled
      ? result
      : {
          ...result,
          eligible: false,
          retryable: false,
          reason: "Booking.com reporting is disabled in this environment. Use the extranet.",
        };
  });
  app.post<{ Params: ReportParams; Body: unknown }>(reportPath, async (request, reply) => {
    const { propertyId, bookingId } = request.params;
    const context = enforcePmsChannexPolicy(request, propertyId, "pms.operations.manage");
    if (!options.noShowReportingEnabled || !options.noShowReports)
      return reply
        .code(409)
        .send({ message: "Booking.com reporting is disabled in this environment." });
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.waivedFees !== "boolean" ||
      typeof body.retry !== "boolean" ||
      Object.keys(body).some((key) => !["waivedFees", "retry"].includes(key))
    )
      return reply.code(400).send({ message: "Choose whether to waive the no-show fee." });
    try {
      const result = await options.noShowReports.submit(
        context,
        propertyId,
        bookingId,
        body.waivedFees,
        body.retry,
      );
      return result
        ? reply.code(202).send(result)
        : reply.code(404).send({ message: "Reservation not found." });
    } catch (error) {
      if (error instanceof NoShowReportingConflict)
        return reply.code(409).send({ message: error.message });
      throw error;
    }
  });

  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex",
    async (request) => {
      const { propertyId } = request.params;
      enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
      return options.repository.getSnapshot(propertyId, options.capabilityModes);
    },
  );

  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex/alerts",
    async (request, reply) => {
      enforcePmsChannexPolicy(request, request.params.propertyId, "pms.operations.read");
      if (!options.repository.getAlerts)
        return reply.code(503).send({ code: "alerts_unavailable" });
      return options.repository.getAlerts(request.params.propertyId);
    },
  );
  app.post<{ Params: { propertyId: string; alertId: string }; Body: { round?: unknown } }>(
    "/properties/:propertyId/channex/alerts/:alertId/:action",
    async (request, reply) => {
      const { propertyId, alertId, action } = request.params as {
        propertyId: string;
        alertId: string;
        action: string;
      };
      const context = enforcePmsChannexPolicy(request, propertyId, "pms.operations.manage");
      if (!/^[0-9a-f-]{36}$/i.test(alertId)) return reply.code(400).send({ code: "invalid_alert" });
      if (action === "acknowledge") {
        const found = await options.repository.acknowledgeAlert?.(
          propertyId,
          alertId,
          context.actor.internalUserId,
        );
        return found ? { ok: true } : reply.code(404).send({ code: "alert_not_found" });
      }
      if (action !== "recover") return reply.code(404).send({ code: "action_not_found" });
      const alerts = await options.repository.getAlerts?.(propertyId);
      const alert = alerts?.find((item) => item.id === alertId);
      if (!alert) return reply.code(404).send({ code: "alert_not_found" });
      const booking = [
        "booking_unmapped_room",
        "booking_unmapped_rate",
        "non_acked_booking",
        "disconnected_channel",
      ].includes(alert.eventType);
      const ari = ["rate_error", "sync_error", "sync_warning", "disconnected_channel"].includes(
        alert.eventType,
      );
      if (
        (booking && options.capabilityModes.bookingSync !== "mutating") ||
        (ari && options.capabilityModes.ariSync !== "mutating")
      )
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      if (
        !Number.isInteger(request.body?.round) ||
        Number(request.body.round) < 0 ||
        Number(request.body.round) >= 3
      )
        return reply.code(400).send({ code: "invalid_recovery_round" });
      if (!options.commandPort?.recoverAlert)
        return reply.code(503).send({ code: "recovery_unavailable" });
      const result = await options.commandPort.recoverAlert(
        context,
        propertyId,
        alertId,
        Number(request.body.round),
      );
      return reply.code(result.ok ? 202 : 409).send(result);
    },
  );

  app.get<{ Params: { propertyId: string; operationId: string } }>(
    "/properties/:propertyId/channex/operations/:operationId",
    async (request, reply) => {
      const { propertyId, operationId } = request.params;
      enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
      const operation = await options.repository.getOperation(propertyId, operationId);
      return operation ?? reply.code(404).send({ code: "operation_not_found" });
    },
  );

  app.post<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/channex/commands",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      const input = parseCommand(request.body);
      if (!input) return reply.code(400).send({ code: "invalid_channex_command" });
      if (!isMutating(options.capabilityModes, input.operationType)) {
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      }
      if (!options.commandPort) {
        return reply.code(503).send({ code: "channex_commands_unavailable" });
      }
      return sendCommandResult(
        reply,
        await options.commandPort.enqueue(context, request.params.propertyId, input),
      );
    },
  );

  app.put<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/channex/markups",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      const input = parseMarkups(request.body);
      if (!input) return reply.code(400).send({ code: "invalid_channex_markups" });
      if (options.capabilityModes.markups !== "mutating") {
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      }
      if (!options.commandPort) {
        return reply.code(503).send({ code: "channex_commands_unavailable" });
      }
      return sendCommandResult(
        reply,
        await options.commandPort.enqueue(context, request.params.propertyId, {
          ...input,
          operationType: "update_markups",
        }),
      );
    },
  );

  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex/stay-restrictions",
    async (request, reply) => {
      enforcePmsChannexPolicy(request, request.params.propertyId, "pms.operations.read");
      if (!options.repository.getStayRestrictions)
        return reply.code(503).send({ code: "channex_commands_unavailable" });
      return { rules: await options.repository.getStayRestrictions(request.params.propertyId) };
    },
  );
  app.put<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/channex/stay-restrictions",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      if (options.capabilityModes.ariSync !== "mutating")
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      const body = request.body as Record<string, unknown> | null;
      const parsed = stayRestrictionReplacement.safeParse(body?.restrictions);
      if (!body || !isCommandIdentity(body.commandId, body.idempotencyKey) || !parsed.success)
        return reply.code(400).send({ code: "invalid_stay_restrictions" });
      if (!options.commandPort)
        return reply.code(503).send({ code: "channex_commands_unavailable" });
      const result = await options.commandPort.enqueue(context, request.params.propertyId, {
        commandId: body.commandId as string,
        idempotencyKey: body.idempotencyKey as string,
        operationType: "sync_ari",
        restrictions: parsed.data,
      });
      if (!result.ok && result.code === "invalid_stay_restrictions")
        return reply.code(400).send(result);
      if (!result.ok && result.code === "stay_restriction_scope_not_found")
        return reply.code(404).send(result);
      return sendCommandResult(reply, result);
    },
  );

  app.post<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex/iframe-session",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      if (options.capabilityModes.iframe !== "mutating") {
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      }
      if (!options.iframeSessionPort) {
        return reply.code(503).send({ code: "channex_iframe_unavailable" });
      }
      const result = await options.iframeSessionPort.createSession(
        context,
        request.params.propertyId,
      );
      if (result.ok) return result;
      return reply.code(result.code === "connection_required" ? 409 : 502).send(result);
    },
  );
}

function parseCommand(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (!isCommandIdentity(value.commandId, value.idempotencyKey)) return null;
  if (
    typeof value.operationType !== "string" ||
    value.operationType === "update_markups" ||
    !CHANNEX_MANAGEMENT_OPERATION_TYPES.includes(
      value.operationType as ChannexManagementOperationType,
    )
  ) {
    return null;
  }
  return {
    commandId: value.commandId as string,
    idempotencyKey: value.idempotencyKey as string,
    operationType: value.operationType as Exclude<ChannexManagementOperationType, "update_markups">,
  };
}

function parseMarkups(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (!isCommandIdentity(value.commandId, value.idempotencyKey) || !Array.isArray(value.markups)) {
    return null;
  }
  const markups = value.markups.map((item) => {
    if (!item || typeof item !== "object") return null;
    const markup = item as Record<string, unknown>;
    return (markup.channel === "booking_com" || markup.channel === "airbnb") &&
      typeof markup.markupPercent === "number" &&
      markup.markupPercent >= -50 &&
      markup.markupPercent <= 200
      ? { channel: markup.channel, markupPercent: markup.markupPercent }
      : null;
  });
  if (markups.some((item) => item === null)) return null;
  return {
    commandId: value.commandId as string,
    idempotencyKey: value.idempotencyKey as string,
    markups: markups as Array<{ channel: string; markupPercent: number }>,
  };
}

function isCommandIdentity(commandId: unknown, idempotencyKey: unknown) {
  return (
    typeof commandId === "string" &&
    commandId.trim().length > 0 &&
    typeof idempotencyKey === "string" &&
    idempotencyKey.trim().length > 0
  );
}

function isMutating(modes: ChannexManagementCapabilityModes, type: ChannexManagementOperationType) {
  const capability = {
    enable: "connection",
    disable: "connection",
    provision: "provisioning",
    sync_ari: "ariSync",
    sync_bookings: "bookingSync",
    update_markups: "markups",
    install_messaging: "messaging",
  }[type] as keyof ChannexManagementCapabilityModes;
  return modes[capability] === "mutating";
}

function sendCommandResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<PmsChannexManagementCommandPort["enqueue"]>>,
) {
  if (result.ok) return reply.code(202).send(result.operation);
  return reply.code(409).send({ code: result.code, message: result.message });
}

export function enforcePmsChannexPolicy(
  request: FastifyRequest,
  propertyId: string,
  permission: "pms.operations.read" | "pms.operations.manage",
) {
  return enforceRoutePolicy(request, {
    permission,
    entitlement: {
      product: "pms",
      key: "property-management",
      resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
    },
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator", "front_desk"],
    },
  });
}
