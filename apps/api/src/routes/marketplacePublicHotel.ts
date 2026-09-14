import type { FastifyInstance } from "fastify";
import type { MarketplacePublicHotel } from "../domains/marketplacePublicHotel.js";

export type MarketplacePublicHotelRoutesOptions = {
  read(propertyId: string): Promise<MarketplacePublicHotel | null>;
};

/** Explicitly public: approved fields only; no setup authorization or write operation. */
export async function registerMarketplacePublicHotelRoutes(
  app: FastifyInstance,
  options: MarketplacePublicHotelRoutesOptions,
) {
  app.get<{ Params: { propertyId: string } }>("/hotels/:propertyId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = request.params.propertyId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return reply.status(400).send({ code: "invalid_property_id" });
    try {
      const hotel = await options.read(id.toLowerCase());
      if (!hotel) return reply.status(404).send({ code: "hotel_not_found" });
      if (hotel.propertyId !== id.toLowerCase()) throw new Error("Invalid public hotel scope");
      return reply.send(hotel);
    } catch {
      return reply.status(503).send({ code: "public_hotel_unavailable" });
    }
  });
}
