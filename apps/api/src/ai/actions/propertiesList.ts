// The properties the user may act on (VAY-2507 proving action; design note §3.2 properties_list).
import { z } from "zod";

import { defineRouteAction } from "./defineRouteAction.js";

export const propertiesList = defineRouteAction({
  name: "properties_list",
  version: 1,
  description:
    "Lists the properties (hotels) you can work on in this account, with their id, name and " +
    "place. Call this first: every other action needs a property id from here.",
  route: "GET /api/hotel-setup/status",
  output: z.object({
    propertySelection: z.object({
      availableProperties: z.array(
        z.object({
          propertyId: z.string(),
          // Null while a property in setup has no name yet.
          displayName: z.string().nullable(),
          locationSummary: z.string().nullable(),
        }),
      ),
    }),
  }),
  permission: "hotel_catalog.property_manifest.read",
  tier: "R1",
  surfaces: ["mcp", "in_app"],
  contractVersion: "adaptive-hotel-setup.v1",
  reviewedBy: "VAY-2507",
  mcpReviewedFields: {
    "propertySelection.availableProperties[].displayName": "the property's own public name",
  },
});
