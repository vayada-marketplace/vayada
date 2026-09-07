import {
  ChannexMealSyncError,
  reconcileChannexMeals,
  type ChannexMeal,
} from "./channexMealSync.js";
import type {
  ChannexConnectedChannel,
  ChannexRatePlanMapping,
  ChannexRoomTypeMapping,
} from "@vayada/domain-pms-channex";

import type {
  ChannexManagementJob,
  ChannexManagementProvider,
  ChannexManagementProviderFailure,
  ChannexManagementProviderSuccess,
} from "../jobs/pmsChannexManagementWorker.js";

type ChannexRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  resolveBody?: (externalRoomTypeIds: ReadonlyMap<string, string>) => unknown;
  skipIf?:
    | { kind: "property" }
    | { kind: "room_type"; roomTypeId: string }
    | { kind: "rate_plan"; ratePlanId: string; channel: string }
    | { kind: "messaging" };
  capture?:
    | { kind: "property" }
    | { kind: "property_list"; title: string }
    | { kind: "property_deleted" }
    | { kind: "channels" }
    | {
        kind: "room_type_list";
        rooms: Array<{ roomTypeId: string; roomTypeName: string }>;
      }
    | { kind: "room_type"; roomTypeId: string; roomTypeName: string }
    | {
        kind: "rate_plan_list";
        rates: Array<{
          roomTypeId: string;
          ratePlanId: string;
          ratePlanName: string;
          providerTitle: string;
          channel: string;
          sellMode: "per_room" | "per_person";
          markupPercent: number;
          externalRoomTypeId?: string;
        }>;
      }
    | {
        kind: "rate_plan";
        roomTypeId: string;
        ratePlanId: string;
        ratePlanName: string;
        channel: string;
        sellMode: "per_room" | "per_person";
        markupPercent: number;
        externalRoomTypeId?: string;
      }
    | { kind: "messaging_list" }
    | { kind: "messaging_installed" };
};

export type ChannexManagementActionPlan = {
  requests: ChannexRequest[];
  meals?: Array<{
    ratePlanId: string;
    channel: string;
    mealType: ChannexMeal["mealType"];
    externalRatePlanId?: string;
    externalRoomTypeId?: string;
  }>;
  recoveryChannelId?: string;
  verifyRecovery?: boolean;
  recoveryScopeCovered?: boolean;
  externalPropertyId?: string;
  roomTypeMappings?: ChannexRoomTypeMapping[];
  ratePlanMappings?: ChannexRatePlanMapping[];
  bookingRevisionHandoff?: (revisions: unknown[]) => Promise<void>;
  checkpoint?: (progress: ChannexManagementProviderSuccess) => Promise<void>;
};

export type ChannexManagementPlanPort = {
  plan(job: ChannexManagementJob): Promise<ChannexManagementActionPlan>;
};

export class ChannexAriMappingMissingError extends Error {
  constructor() {
    super("Future availability cannot sync: an active Channex room or rate mapping is missing.");
  }
}

export function createChannexManagementProvider(config: {
  apiBaseUrl: string;
  apiKey: string;
  plans: ChannexManagementPlanPort;
  fetch?: typeof fetch;
  canSyncAri?: boolean;
}): ChannexManagementProvider {
  const apiBaseUrl = requiredUrl(config.apiBaseUrl);
  const apiKey = required(config.apiKey, "Channex apiKey");
  const fetcher = config.fetch ?? fetch;
  return {
    async execute(job, input) {
      if (job.input.operationType === "sync_ari" && config.canSyncAri === false) {
        return failure("invalid_state", new Error("Channex ARI capability is not mutating."));
      }
      let plan: ChannexManagementActionPlan;
      try {
        plan = await config.plans.plan(job);
      } catch (error) {
        return failure(
          error instanceof ChannexAriMappingMissingError ? "mapping_missing" : "invalid_state",
          error,
        );
      }
      if (plan.recoveryChannelId) {
        await input?.onProgress?.();
        const response = await fetcher(
          new URL(`/api/v1/channels/${encodeURIComponent(plan.recoveryChannelId)}`, apiBaseUrl),
          { headers: { "user-api-key": apiKey }, signal: AbortSignal.timeout(30_000) },
        );
        if (!response.ok) return responseFailure(response);
        const body = (await response.json()) as { data?: Record<string, unknown> };
        const channel = (body.data?.attributes ?? body.data) as Record<string, unknown> | undefined;
        if (
          !channel ||
          channel.is_active !== true ||
          !Array.isArray(channel.properties) ||
          !channel.properties.includes(plan.externalPropertyId)
        )
          return failure(
            "invalid_state",
            new Error("Reconnect this channel in channel settings before retrying."),
          );
      }
      let lastRequestId: string | undefined;
      let revisions: unknown[] = [];
      let externalPropertyId = plan.externalPropertyId;
      let connectionStatus: ChannexManagementProviderSuccess["connectionStatus"];
      let messagingAppInstalled: boolean | undefined;
      const roomTypeMappings = new Map(
        (plan.roomTypeMappings ?? []).map((mapping) => [mapping.roomTypeId, mapping]),
      );
      const externalRoomTypeIds = new Map(
        [...roomTypeMappings].map(([id, mapping]) => [id, mapping.externalRoomTypeId]),
      );
      const ratePlanMappings = new Map(
        (plan.ratePlanMappings ?? []).map((mapping) => [rateKey(mapping), mapping]),
      );
      let channels: ChannexConnectedChannel[] | undefined;
      for (const request of plan.requests) {
        if (
          shouldSkip(
            request,
            externalPropertyId,
            externalRoomTypeIds,
            ratePlanMappings,
            messagingAppInstalled,
          )
        ) {
          continue;
        }
        try {
          await input?.onProgress?.();
          const response = await fetcher(requestUrl(apiBaseUrl, request), {
            method: request.method,
            headers: {
              "content-type": "application/json",
              "user-api-key": apiKey,
            },
            body:
              request.body === undefined && !request.resolveBody
                ? undefined
                : JSON.stringify(request.resolveBody?.(externalRoomTypeIds) ?? request.body),
            signal: AbortSignal.timeout(30_000),
          });
          lastRequestId = response.headers.get("x-request-id") ?? lastRequestId;
          if (
            !response.ok &&
            !(response.status === 404 && request.capture?.kind === "property_deleted")
          ) {
            return await responseFailure(response, lastRequestId);
          }
          if (
            plan.verifyRecovery &&
            response.status === 204 &&
            ["/api/v1/availability", "/api/v1/restrictions"].includes(request.path)
          )
            return failure(
              "provider_unavailable",
              new Error("Channex returned no verification evidence."),
            );
          if (response.status !== 204) {
            const responseBody = response.status === 404 ? undefined : await response.json();
            if (
              !plan.verifyRecovery &&
              request.path === "/api/v1/restrictions" &&
              hasAriWarnings(responseBody)
            ) {
              return {
                ok: false,
                code: "provider_rejected",
                message: "Channex rejected one or more ARI values",
                providerRequestId: lastRequestId,
              };
            }
            if (
              plan.verifyRecovery &&
              ["/api/v1/availability", "/api/v1/restrictions"].includes(request.path)
            ) {
              const body = responseBody as { meta?: { warnings?: unknown[] } };
              if (!body?.meta || !Array.isArray(body.meta.warnings) || hasAriWarnings(responseBody))
                return failure(
                  "invalid_payload",
                  new Error(
                    "Channex rejected part of the update. Review rate and availability settings.",
                  ),
                );
              const verified = await verifyAriReadback(
                fetcher,
                apiBaseUrl,
                apiKey,
                request,
                input?.onProgress,
              );
              if (!verified)
                return failure(
                  "provider_unavailable",
                  new Error("Channex has not confirmed the submitted values yet."),
                );
            }
            if (request.path === "/api/v1/booking_revisions/feed") {
              revisions = dataList(responseBody);
            }
            if (request.capture?.kind === "channels") {
              channels = dataList(responseBody)
                .map(channelFromProvider)
                .filter((channel): channel is ChannexConnectedChannel => channel !== null);
            }
            const externalId = capturesSingleId(request.capture) ? dataId(responseBody) : undefined;
            if (request.capture?.kind === "property") {
              externalPropertyId = externalId;
              connectionStatus = "connected";
            }
            if (request.capture?.kind === "property_list") {
              externalPropertyId = findByTitle(responseBody, request.capture.title)?.id;
              if (externalPropertyId) connectionStatus = "connected";
            }
            if (request.capture?.kind === "property_deleted") {
              externalPropertyId = undefined;
              connectionStatus = "disconnected";
            }
            if (request.capture?.kind === "room_type_list") {
              for (const room of request.capture.rooms) {
                const found = findByTitle(responseBody, room.roomTypeName);
                if (found)
                  addRoomMapping(roomTypeMappings, externalRoomTypeIds, job, room, found.id);
              }
            }
            if (request.capture?.kind === "room_type") {
              addRoomMapping(
                roomTypeMappings,
                externalRoomTypeIds,
                job,
                request.capture,
                externalId!,
              );
            }
            if (request.capture?.kind === "rate_plan_list") {
              for (const rate of request.capture.rates) {
                const externalRoomTypeId =
                  rate.externalRoomTypeId ?? externalRoomTypeIds.get(rate.roomTypeId);
                const found = findRate(responseBody, rate.providerTitle, externalRoomTypeId);
                if (found && externalRoomTypeId) {
                  addRateMapping(ratePlanMappings, job, rate, externalRoomTypeId, found.id);
                }
              }
            }
            if (request.capture?.kind === "rate_plan") {
              const externalRoomTypeId =
                request.capture.externalRoomTypeId ??
                externalRoomTypeIds.get(request.capture.roomTypeId);
              if (!externalRoomTypeId) {
                return failure("invalid_state", new Error("Missing room mapping"));
              }
              addRateMapping(
                ratePlanMappings,
                job,
                request.capture,
                externalRoomTypeId,
                externalId!,
              );
            }
            if (request.capture?.kind === "messaging_list") {
              messagingAppInstalled = dataList(responseBody).some(isMessagingApplication);
            }
            if (request.capture?.kind === "messaging_installed") messagingAppInstalled = true;
          }
          if (request.capture?.kind === "property_deleted") {
            externalPropertyId = undefined;
            connectionStatus = "disconnected";
          }
          if (request.capture?.kind === "messaging_installed") messagingAppInstalled = true;
          await plan.checkpoint?.(
            progress({
              lastRequestId,
              externalPropertyId,
              connectionStatus,
              messagingAppInstalled,
              roomTypeMappings,
              ratePlanMappings,
              channels,
            }),
          );
        } catch (error) {
          return failure(isTimeout(error) ? "timeout" : "provider_unavailable", error);
        }
      }
      try {
        const meals = (plan.meals ?? []).map((meal) => {
          const mapping = ratePlanMappings.get(rateKey(meal));
          const externalRatePlanId = meal.externalRatePlanId ?? mapping?.externalRatePlanId;
          const externalRoomTypeId = meal.externalRoomTypeId ?? mapping?.externalRoomTypeId;
          if (!externalRatePlanId || !externalRoomTypeId)
            throw new ChannexMealSyncError("Missing Channex meal rate mapping");
          return { externalRatePlanId, externalRoomTypeId, mealType: meal.mealType };
        });
        await reconcileChannexMeals(externalPropertyId!, meals, async (method, path, body) => {
          await input?.onProgress?.();
          const response = await fetcher(new URL(path, `${apiBaseUrl}/`), {
            method,
            headers: { "content-type": "application/json", "user-api-key": apiKey },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          lastRequestId = response.headers.get("x-request-id") ?? lastRequestId;
          if (!response.ok) throw response;
          return response.status === 204 ? undefined : response.json();
        });
      } catch (error) {
        if (error instanceof Response) return responseFailure(error, lastRequestId);
        return failure(
          error instanceof ChannexMealSyncError
            ? "invalid_state"
            : isTimeout(error)
              ? "timeout"
              : "provider_unavailable",
          error,
        );
      }
      if (plan.bookingRevisionHandoff) {
        try {
          await plan.bookingRevisionHandoff(revisions);
        } catch (error) {
          return failure("provider_unavailable", error);
        }
      }
      return {
        ...progress({
          lastRequestId,
          externalPropertyId,
          connectionStatus,
          messagingAppInstalled,
          roomTypeMappings,
          ratePlanMappings,
          channels,
        }),
        ...(plan.verifyRecovery
          ? { alertRecoveryVerified: plan.recoveryScopeCovered !== false }
          : {}),
      };
    },
  };
}

async function responseFailure(
  response: Response,
  providerRequestId?: string,
): Promise<ChannexManagementProviderFailure> {
  const message = await safeResponseMessage(response);
  const code =
    response.status === 429
      ? "rate_limited"
      : response.status >= 500
        ? "provider_unavailable"
        : response.status === 400 || response.status === 422
          ? "invalid_payload"
          : "provider_rejected";
  return { ok: false, code, message, statusCode: response.status, providerRequestId };
}

async function safeResponseMessage(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) return `Channex request failed with HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    return JSON.stringify(parsed.errors ?? parsed).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function failure(
  code: ChannexManagementProviderFailure["code"],
  error: unknown,
): ChannexManagementProviderFailure {
  return {
    ok: false,
    code,
    message: (error instanceof Error ? error.message : "Channex request failed").slice(0, 500),
  };
}

function requestUrl(base: string, request: ChannexRequest): string {
  const url = new URL(request.path, `${base}/`);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function dataList(value: unknown): unknown[] {
  return value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
    ? ((value as { data: unknown[] }).data ?? [])
    : [];
}

function dataId(value: unknown): string {
  const data = value && typeof value === "object" ? (value as { data?: unknown }).data : undefined;
  const id = data && typeof data === "object" ? (data as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) throw new Error("Channex response omitted data.id");
  return id;
}

function capturesSingleId(capture: ChannexRequest["capture"]): boolean {
  return (
    capture?.kind === "property" || capture?.kind === "room_type" || capture?.kind === "rate_plan"
  );
}

function findByTitle(
  value: unknown,
  title: string,
): { id: string; attributes: Record<string, unknown> } | null {
  return (
    dataList(value)
      .map(dataItem)
      .find((item) => item?.attributes.title === title) ?? null
  );
}

function findRate(value: unknown, title: string, roomTypeId?: string) {
  return dataList(value)
    .map(dataItem)
    .find(
      (item) =>
        item?.attributes.title === title &&
        (!roomTypeId ||
          item.attributes.room_type_id === roomTypeId ||
          item.relationships?.room_type === roomTypeId),
    );
}

function dataItem(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string") return null;
  const attributes =
    item.attributes && typeof item.attributes === "object"
      ? (item.attributes as Record<string, unknown>)
      : item;
  const relationships: Record<string, string> = {};
  if (item.relationships && typeof item.relationships === "object") {
    for (const [key, relationship] of Object.entries(
      item.relationships as Record<string, unknown>,
    )) {
      const data =
        relationship && typeof relationship === "object"
          ? (relationship as { data?: unknown }).data
          : null;
      if (data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string") {
        relationships[key] = (data as { id: string }).id;
      }
    }
  }
  return { id: item.id, attributes, relationships };
}

function addRoomMapping(
  mappings: Map<string, ChannexRoomTypeMapping>,
  externalIds: Map<string, string>,
  job: ChannexManagementJob,
  room: { roomTypeId: string; roomTypeName: string },
  externalRoomTypeId: string,
) {
  externalIds.set(room.roomTypeId, externalRoomTypeId);
  mappings.set(room.roomTypeId, {
    mappingId: job.jobId,
    ...room,
    externalRoomTypeId,
    status: "active",
  });
}

function addRateMapping(
  mappings: Map<string, ChannexRatePlanMapping>,
  job: ChannexManagementJob,
  rate: {
    roomTypeId: string;
    ratePlanId: string;
    ratePlanName: string;
    channel: string;
    sellMode: "per_room" | "per_person";
    markupPercent: number;
  },
  externalRoomTypeId: string,
  externalRatePlanId: string,
) {
  mappings.set(rateKey(rate), {
    mappingId: job.jobId,
    roomTypeId: rate.roomTypeId,
    ratePlanId: rate.ratePlanId,
    ratePlanName: rate.ratePlanName,
    channel: rate.channel,
    sellMode: rate.sellMode,
    markupPercent: rate.markupPercent,
    externalRoomTypeId,
    externalRatePlanId,
    status: "active",
  });
}

function rateKey(value: { ratePlanId: string; channel: string }) {
  return `${value.ratePlanId}:${value.channel}`;
}

function shouldSkip(
  request: ChannexRequest,
  externalPropertyId: string | undefined,
  roomTypes: ReadonlyMap<string, string>,
  rates: ReadonlyMap<string, ChannexRatePlanMapping>,
  messagingAppInstalled: boolean | undefined,
) {
  const skip = request.skipIf;
  if (!skip) return false;
  if (skip.kind === "property") return Boolean(externalPropertyId);
  if (skip.kind === "room_type") return roomTypes.has(skip.roomTypeId);
  if (skip.kind === "rate_plan") return rates.has(rateKey(skip));
  return messagingAppInstalled === true;
}

function isMessagingApplication(value: unknown) {
  const item = dataItem(value);
  return item?.attributes.application_code === "channex_messages";
}

function progress(input: {
  lastRequestId?: string;
  externalPropertyId?: string;
  connectionStatus?: ChannexManagementProviderSuccess["connectionStatus"];
  messagingAppInstalled?: boolean;
  roomTypeMappings: ReadonlyMap<string, ChannexRoomTypeMapping>;
  ratePlanMappings: ReadonlyMap<string, ChannexRatePlanMapping>;
  channels?: ChannexConnectedChannel[];
}): ChannexManagementProviderSuccess {
  return {
    ok: true,
    providerRequestId: input.lastRequestId,
    externalPropertyId: input.externalPropertyId,
    connectionStatus: input.connectionStatus,
    messagingAppInstalled: input.messagingAppInstalled,
    roomTypeMappings: [...input.roomTypeMappings.values()],
    ratePlanMappings: [...input.ratePlanMappings.values()],
    channels: input.channels,
  };
}

function channelFromProvider(value: unknown): ChannexConnectedChannel | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const attributes =
    item.attributes && typeof item.attributes === "object"
      ? (item.attributes as Record<string, unknown>)
      : item;
  if (typeof attributes.application !== "string") return null;
  return {
    key: canonicalChannel(attributes.application),
    application: attributes.application,
    title: typeof attributes.title === "string" ? attributes.title : null,
    isActive: attributes.is_active === true,
  };
}

function canonicalChannel(application: string) {
  const key = application.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (key.includes("booking")) return "booking_com";
  if (key.includes("airbnb") || key.includes("abnb")) return "airbnb";
  return key || "other";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

function requiredUrl(value: string): string {
  const url = new URL(required(value, "Channex apiBaseUrl"));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Channex apiBaseUrl must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export const channexRequests = {
  findProperty: (title: string): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/properties",
    query: {
      "filter[title]": title,
      "pagination[page]": "1",
      "pagination[limit]": "100",
    },
    capture: { kind: "property_list", title },
  }),
  createProperty: (property: Record<string, unknown>): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/properties",
    body: { property },
    skipIf: { kind: "property" },
    capture: { kind: "property" },
  }),
  updateProperty: (
    externalPropertyId: string,
    property: Record<string, unknown>,
  ): ChannexRequest => ({
    method: "PUT",
    path: `/api/v1/properties/${encodeURIComponent(externalPropertyId)}`,
    body: { property },
  }),
  deleteProperty: (externalPropertyId: string): ChannexRequest => ({
    method: "DELETE",
    path: `/api/v1/properties/${encodeURIComponent(externalPropertyId)}`,
    capture: { kind: "property_deleted" },
  }),
  listRoomTypes: (
    externalPropertyId: string,
    rooms: Array<{ roomTypeId: string; roomTypeName: string }>,
  ): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/room_types",
    query: {
      "filter[property_id]": externalPropertyId,
      ...(rooms[0] ? { "filter[title]": rooms[0].roomTypeName } : {}),
      "pagination[page]": "1",
      "pagination[limit]": "100",
    },
    capture: { kind: "room_type_list", rooms },
  }),
  createRoomType: (input: {
    roomTypeId: string;
    roomTypeName: string;
    roomType: Record<string, unknown>;
  }): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/room_types",
    body: { room_type: input.roomType },
    skipIf: { kind: "room_type", roomTypeId: input.roomTypeId },
    capture: { kind: "room_type", roomTypeId: input.roomTypeId, roomTypeName: input.roomTypeName },
  }),
  createRatePlan: (input: {
    roomTypeId: string;
    ratePlanId: string;
    ratePlanName: string;
    channel: string;
    sellMode: "per_room" | "per_person";
    markupPercent: number;
    externalRoomTypeId?: string;
    ratePlan: Record<string, unknown>;
  }): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/rate_plans",
    resolveBody: (externalRoomTypeIds) => ({
      rate_plan: {
        ...input.ratePlan,
        room_type_id: required(
          input.externalRoomTypeId ?? externalRoomTypeIds.get(input.roomTypeId) ?? "",
          `External room type ${input.roomTypeId}`,
        ),
      },
    }),
    skipIf: { kind: "rate_plan", ratePlanId: input.ratePlanId, channel: input.channel },
    capture: {
      kind: "rate_plan",
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      ratePlanName: input.ratePlanName,
      channel: input.channel,
      sellMode: input.sellMode,
      markupPercent: input.markupPercent,
      externalRoomTypeId: input.externalRoomTypeId,
    },
  }),
  listRatePlans: (
    externalPropertyId: string,
    rates: Array<{
      roomTypeId: string;
      ratePlanId: string;
      ratePlanName: string;
      providerTitle: string;
      channel: string;
      sellMode: "per_room" | "per_person";
      markupPercent: number;
      externalRoomTypeId?: string;
    }>,
  ): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/rate_plans",
    query: {
      "filter[property_id]": externalPropertyId,
      ...(rates[0] ? { "filter[title]": rates[0].providerTitle } : {}),
      "pagination[page]": "1",
      "pagination[limit]": "100",
    },
    capture: { kind: "rate_plan_list", rates },
  }),
  availability: (values: unknown[]): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/availability",
    body: { values },
  }),
  restrictions: (values: unknown[]): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/restrictions",
    body: { values },
  }),
  bookingRevisionFeed: (externalPropertyId: string): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/booking_revisions/feed",
    query: { "filter[property_id]": externalPropertyId, "order[inserted_at]": "asc" },
  }),
  listInstalledApplications: (externalPropertyId: string): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/applications/installed",
    query: { "filter[property_id]": externalPropertyId },
    capture: { kind: "messaging_list" },
  }),
  installMessaging: (externalPropertyId: string): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/applications/install",
    body: {
      application_installation: {
        property_id: externalPropertyId,
        application_code: "channex_messages",
      },
    },
    skipIf: { kind: "messaging" },
    capture: { kind: "messaging_installed" },
  }),
  listChannels: (externalPropertyId: string): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/channels",
    query: { "filter[property_id]": externalPropertyId, "pagination[limit]": "100" },
    capture: { kind: "channels" },
  }),
};

function hasAriWarnings(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      ((key === "warning" || key === "warnings" || key === "errors") &&
        item != null &&
        (typeof item !== "object" || Object.keys(item).length > 0)) ||
      hasAriWarnings(item),
  );
}

async function verifyAriReadback(
  fetcher: typeof fetch,
  base: string,
  apiKey: string,
  request: ChannexRequest,
  progress?: () => Promise<void>,
) {
  const values = (request.body as { values?: Record<string, unknown>[] } | undefined)?.values;
  if (!values?.length) return false;
  const dates = values.flatMap((value) => [String(value.date_from), String(value.date_to)]).sort();
  const url = new URL(request.path, base);
  url.searchParams.set("filter[property_id]", String(values[0]!.property_id));
  url.searchParams.set("filter[date][gte]", dates[0]!);
  url.searchParams.set("filter[date][lte]", dates.at(-1)!);
  const availability = request.path.endsWith("availability");
  const fields = availability
    ? ["availability"]
    : [
        ...new Set(
          values.flatMap((value) =>
            Object.keys(value).filter(
              (key) => !["property_id", "rate_plan_id", "date_from", "date_to"].includes(key),
            ),
          ),
        ),
      ];
  if (!fields.length) return false;
  if (!availability) url.searchParams.set("filter[restrictions]", fields.join(","));
  await progress?.();
  const response = await fetcher(url, {
    headers: { "user-api-key": apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { data?: Record<string, Record<string, unknown>> };
  return values.every((value) => {
    if (value.date_from !== value.date_to) return false;
    const actual =
      body.data?.[String(value[availability ? "room_type_id" : "rate_plan_id"])]?.[
        String(value.date_from)
      ];
    return fields
      .filter((field) => field in value)
      .every((field) => {
        const read = availability
          ? actual
          : (actual as Record<string, unknown> | undefined)?.[field];
        const expected = value[field];
        return typeof expected === "boolean"
          ? read === expected
          : read !== null &&
              read !== undefined &&
              typeof read !== "boolean" &&
              Number.isFinite(Number(read)) &&
              Number(read) === Number(expected);
      });
  });
}
