import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type BookingAdminCompatRoutesOptions = {
  allowedOrigins?: string[];
};

type HotelSummary = {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
};

export async function registerBookingAdminCompatRoutes(
  app: FastifyInstance,
  options: BookingAdminCompatRoutesOptions = {},
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    writeCompatCorsHeaders(request, reply, options.allowedOrigins ?? []);
  });

  app.options("/settings/setup-status", async (_request, reply) => reply.code(204).send());
  app.options("/hotels", async (_request, reply) => reply.code(204).send());

  app.get("/settings/setup-status", async (request) => {
    const hotels = getLinkedBookingHotels(request);
    return {
      setup_complete: hotels.length > 0,
      missing_fields: [],
      prefill_data: null,
    };
  });

  app.get("/hotels", async (request) => getLinkedBookingHotels(request));

  app.post("/hotels", async (_request, reply) =>
    reply.code(501).send({
      detail: "Booking setup creation is not available on next-api yet.",
    }),
  );
}

function getLinkedBookingHotels(request: FastifyRequest): HotelSummary[] {
  const context = requireAuthContext(request);
  return context.linkedResources
    .filter(
      (link) =>
        link.status === "active" &&
        link.product === "booking" &&
        link.resourceType === "booking_hotel",
    )
    .map((link) => ({
      id: link.resourceId,
      name: link.resourceId,
      slug: link.resourceId,
      location: "",
      country: "",
    }));
}

function writeCompatCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): void {
  const origin = request.headers.origin;
  reply.header("Vary", "Origin");
  if (!origin || !allowedOrigins.includes(origin)) return;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
    .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}
