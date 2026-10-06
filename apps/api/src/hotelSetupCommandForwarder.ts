import type { FastifyReply, FastifyRequest } from "fastify";
import { readIdempotencyKey } from "./routes/pmsPricing.js";

type Operation =
  | "currency"
  | "modules"
  | "financials"
  | "property_creation"
  | "launch_settings"
  | "logo_upload"
  | "logo_finalize"
  | "logo_assignment";
export type HotelSetupCommandForwarder = (
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string | null,
  operation: Operation,
) => Promise<unknown>;

/** Optional, fixed private destination; never selects credentials or falls back to local writes. */
export function loadHotelSetupCommandForwarder(
  env: NodeJS.ProcessEnv = process.env,
  transport: typeof fetch = fetch,
): HotelSetupCommandForwarder | undefined {
  const admission = env["HOTEL_SETUP_COMMAND_ADMISSION"];
  if (admission !== undefined && admission !== "blocked" && admission !== "enabled")
    throw new Error("Invalid hotel setup admission configuration");
  if (admission === "blocked")
    return async (_request, reply) =>
      reply.header("Cache-Control", "no-store").code(503).send({ code: "hotel_setup_unavailable" });
  const origin = env["HOTEL_SETUP_COMMAND_ORIGIN"]?.trim();
  const internalToken = env["HOTEL_SETUP_COMMAND_INTERNAL_TOKEN"];
  if (!origin && !internalToken) {
    if (admission === "enabled") throw new Error("Private hotel setup forwarding is required");
    return undefined;
  }
  let destination: URL;
  try {
    destination = new URL(origin!);
  } catch {
    throw new Error("Invalid hotel setup command origin");
  }
  if (
    !["http:", "https:"].includes(destination.protocol) ||
    !destination.hostname ||
    destination.username ||
    destination.password ||
    destination.pathname !== "/" ||
    destination.search ||
    destination.hash ||
    !internalToken ||
    Buffer.byteLength(internalToken) < 32 ||
    (destination.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname))
  )
    throw new Error("Invalid hotel setup forwarding configuration");

  return async (request, reply, propertyId, operation) => {
    reply.header("Cache-Control", "no-store");
    if (
      (operation === "property_creation"
        ? propertyId !== null
        : typeof propertyId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            propertyId,
          )) ||
      Object.keys(request.query as object).length !== 0
    )
      return reply.code(400).send({ code: "invalid_request" });
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer \S+$/i.test(authorization))
      return reply.code(401).send({ code: "unauthenticated" });
    const suffix =
      operation === "logo_assignment"
        ? "media/logo"
        : operation === "launch_settings"
          ? "launch-settings"
          : operation === "currency"
            ? "pricing-source/currency"
            : operation === "modules"
              ? "module-activations"
              : "module-activations/financials";
    const method =
      operation === "property_creation" ||
      operation === "logo_upload" ||
      operation === "logo_finalize"
        ? "POST"
        : operation === "currency" ||
            operation === "launch_settings" ||
            operation === "logo_assignment"
          ? "PUT"
          : operation === "modules"
            ? "GET"
            : "PATCH";
    if (request.method !== method) return reply.code(400).send({ code: "invalid_request" });
    const headers: Record<string, string> = {
      authorization,
      "x-vayada-internal-token": internalToken,
      "content-type": "application/json",
    };
    if (
      operation === "currency" ||
      operation === "property_creation" ||
      operation === "logo_assignment"
    ) {
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return reply.code(400).send({ code: "invalid_request" });
      headers["idempotency-key"] = idempotencyKey;
    }
    try {
      const response = await transport(
        new URL(
          operation === "property_creation"
            ? "/properties"
            : operation === "logo_upload"
              ? "/media/upload-sessions"
              : operation === "logo_finalize"
                ? `/media/upload-sessions/${propertyId}/finalize`
                : `/properties/${propertyId}/${suffix}`,
          destination,
        ),
        {
          method,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(
            operation === "logo_finalize" || operation === "logo_assignment" ? 30_000 : 5_000,
          ),
          ...(method === "GET" ? {} : { body: JSON.stringify(request.body) }),
        },
      );
      if (![200, 201, 400, 401, 403, 404, 409, 410, 422].includes(response.status))
        throw new Error();
      const body: unknown = await response.json();
      return reply.code(response.status).send(body);
    } catch {
      return reply.code(503).send({ code: "hotel_setup_unavailable" });
    }
  };
}
