import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { loadConfig } from "../config.js";
import { retainedRevisionScope as retained } from "./channexStagingCatalogEvidence.js";
export const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("Test database required");
const targetDatabaseUrl = databaseUrl ?? "postgresql://api_test@localhost/test";
const managementDatabaseUrl = new URL(targetDatabaseUrl);
managementDatabaseUrl.username = "channex_test_worker";
export const propertyId = retained.propertyId,
  roomId = retained.roomId,
  rateId = retained.rateId;
export const input = {
  providerPropertyId: retained.providerPropertyId,
  bookingId: retained.bookingId,
  revisionId: retained.revisionId,
  channelId: randomUUID(),
  approvalRef: "VAY-1981:catalog-test",
};
export const config = () => ({
  ...loadConfig({
    API_BACKGROUND_WORKERS_ENABLED: "false",
    PMS_OPERATIONS_SOURCE: "target",
    TARGET_DATABASE_URL: targetDatabaseUrl,
    PMS_CHANNEX_MANAGEMENT_DATABASE_URL: managementDatabaseUrl.toString(),
    CHANNEX_API_BASE_URL: "https://staging.channex.io",
    CHANNEX_API_KEY: "synthetic",
    PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
    PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: propertyId,
  }),
  apiRuntime: "next" as const,
});
export const relation = (id: string) => ({ data: { id } });
export function provider(retainedRevision = false) {
  const data: Record<string, any> = {
    [`booking_revisions/${input.revisionId}`]: {
      id: input.revisionId,
      attributes: {
        booking_id: input.bookingId,
        property_id: input.providerPropertyId,
        ota_name: "Booking.com",
        status: "new",
        inserted_at: "2026-09-12T12:00:00Z",
        currency: "GBP",
        arrival_date: "2026-09-12",
        departure_date: "2026-09-13",
        amount: "80.00",
        rooms: [
          {
            occupancy: { adults: 2, children: 0 },
            room_type_id: roomId,
            rate_plan_id: rateId,
            meta: { room_type_code: "586818903", rate_plan_code: "16385047" },
          },
        ],
      },
    },
    [`channels/${input.channelId}`]: {
      id: input.channelId,
      attributes: {
        channel: "BookingCom",
        is_active: true,
        currency: "GBP",
        properties: [input.providerPropertyId],
        rate_plans: [
          {
            rate_plan_id: rateId,
            settings: { room_type_code: "586818903", rate_plan_code: "16385047" },
          },
        ],
      },
    },
    [`room_types/${roomId}`]: {
      id: roomId,
      attributes: {
        title: "Synthetic Double",
        room_kind: "room",
        occ_adults: 2,
        occ_children: 0,
        count_of_rooms: 10,
        default_occupancy: 2,
      },
      relationships: { property: relation(input.providerPropertyId) },
    },
    [`rate_plans/${rateId}`]: {
      id: rateId,
      attributes: {
        title: "Synthetic special rate",
        currency: "GBP",
        rate_mode: "manual",
        sell_mode: "per_room",
        meal_type: "none",
        options: [{ is_primary: true, occupancy: 2, rate: "80.00" }],
      },
      relationships: { property: relation(input.providerPropertyId), room_type: relation(roomId) },
    },
  };
  if (retainedRevision) {
    Object.assign(data[`booking_revisions/${input.revisionId}`].attributes, {
      channel_id: null,
      is_crs_revision: false,
      ota_reservation_code: retained.otaBookingCode,
    });
    data[`booking_revisions/${input.revisionId}`].attributes.rooms[0].meta.rate_plan_code =
      retained.otaRateCode;
    data["channels/mapping_details"] = {
      pricing_type: "Standard",
      rooms: [
        {
          id: retained.otaRoomCode,
          rates: [
            {
              id: retained.otaRateCode,
              pricing: "Standard",
              readonly: false,
              parent_rate_id: "",
              max_persons: 2,
            },
          ],
        },
      ],
    };
    data["channels/connection_details"] = { attributes: { currency: "GBP" } };
    delete data[`channels/${input.channelId}`];
  }
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname.replace("/api/v1/", "");
    expect(init?.method ?? "GET").toBe(
      retainedRevision && path.startsWith("channels/") ? "POST" : "GET",
    );
    if (init?.method === "POST")
      expect(JSON.parse(String(init.body))).toEqual({
        channel: "BookingCom",
        settings: { hotel_id: retained.hotelId },
      });
    if (!data[path]) throw new Error("Unexpected provider path");
    return Response.json({ data: data[path] });
  });
  return { data, request };
}
