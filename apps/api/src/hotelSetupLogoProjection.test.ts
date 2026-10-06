import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE,
  ensureCanonicalPropertySlug,
  slugify,
} from "./platform/publicBookabilityPublication.js";
import { syncOfferReadModel } from "./routes/marketplaceAdmin.js";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/backend-migration/migrations/0469_hotel_setup_logo_projection.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
describe("native logo canonical projection", () => {
  it("freezes the existing Catalog and Marketplace SQL without caller values", async () => {
    expect(migration).toContain(
      PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE.trim().replaceAll(
        "$1::uuid",
        "requested_property_id",
      ),
    );
    let offerProjection = "";
    await syncOfferReadModel(
      {
        query: async (sql: string) => {
          if (sql.includes("SELECT offer.property_id"))
            return { rows: [{ propertyId: "11111111-1111-4111-8111-111111111111" }] };
          offerProjection = sql;
          return { rows: [] };
        },
      } as Parameters<typeof syncOfferReadModel>[0],
      "11111111-1111-4111-8111-111111111111",
      "initialize",
      { catalogAlreadyProjected: true },
    );
    expect(migration).toContain(
      offerProjection
        .trim()
        .replaceAll("$1::uuid", "selected_offer_id")
        .replaceAll("$2", "'initialize'"),
    );
    expect(migration).toContain(
      "platform.hotel_setup_logo_allowed(requested_property_id, assignment.organization_id, assignment.actor_user_id)",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION platform.sync_hotel_setup_logo_read_models(UUID) FROM PUBLIC",
    );
  });
  it("retains canonical slug's accent normalization and bounded two candidates", async () => {
    expect(slugify("Hôtel Änimals!")).toBe("hotel-animals");
    const candidates: string[] = [];
    await expect(
      ensureCanonicalPropertySlug(
        {
          query: async (sql: string, values?: readonly unknown[]) => {
            if (sql.includes("SELECT\n    property.id"))
              return {
                rows: [
                  {
                    propertyId: "11111111-1111-4111-8111-111111111111",
                    publicId: "Sri Journeys",
                    displayName: "Hôtel Änimals!",
                    canonicalSlug: null,
                  },
                ],
              };
            candidates.push(values![1] as string);
            return { rows: [] };
          },
        } as Parameters<typeof ensureCanonicalPropertySlug>[0],
        "11111111-1111-4111-8111-111111111111",
      ),
    ).rejects.toThrow("Unable to reserve");
    expect(candidates).toEqual(["hotel-animals", "hotel-animals-sri-journeys"]);
  });
});
