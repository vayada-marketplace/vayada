import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { readStagingCatalogEvidence } from "./channexStagingCatalogEvidence.js";
import { input, roomId, rateId, relation, provider } from "./channexStagingCatalogTestFixture.js";
it("rejects missing, mismatched, ambiguous and unsupported provider evidence", async () => {
  const changes = [
    (d: Record<string, any>) => {
      d[`booking_revisions/${input.revisionId}`].attributes.rooms[0].rate_plan_id = null;
    },
    (d: Record<string, any>) => {
      d[`booking_revisions/${input.revisionId}`].attributes.property_id = randomUUID();
    },
    (d: Record<string, any>) => {
      d[`channels/${input.channelId}`].attributes.rate_plans[0].settings.rate_plan_code =
        "16385046";
    },
    (d: Record<string, any>) => {
      d[`channels/${input.channelId}`].attributes.rate_plans.push(
        d[`channels/${input.channelId}`].attributes.rate_plans[0],
      );
    },
    (d: Record<string, any>) => {
      d[`rate_plans/${rateId}`].relationships.room_type = relation(randomUUID());
    },
    (d: Record<string, any>) => {
      d[`room_types/${roomId}`].attributes.count_of_rooms = 1000;
    },
    (d: Record<string, any>) => {
      d[`rate_plans/${rateId}`].attributes.currency = "USD";
    },
  ];
  for (const change of changes) {
    const { data, request } = provider();
    change(data);
    await expect(readStagingCatalogEvidence(input, "synthetic", request)).rejects.toThrow();
  }
});

it("accepts pure parent inheritance but rejects derived pricing formulas", async () => {
  const { data, request } = provider(),
    parentId = randomUUID();
  data[`rate_plans/${parentId}`] = structuredClone(data[`rate_plans/${rateId}`]);
  data[`rate_plans/${parentId}`].id = parentId;
  data[`channels/${input.channelId}`].attributes.rate_plans[0].rate_plan_id = parentId;
  const rate = data[`rate_plans/${rateId}`];
  rate.relationships.parent_rate_plan = relation(parentId);
  rate.relationships.channel = relation(input.channelId);
  Object.assign(rate.attributes, {
    rate_mode: "derived",
    inherit_rate: true,
    options: [{ inherit_rate: true, derived_option: {}, occupancy: 2 }],
  });
  await expect(readStagingCatalogEvidence(input, "synthetic", request)).resolves.toMatchObject({
    parentId,
    amount: "80.00",
  });
  rate.attributes.options[0].derived_option = { rate: [["increase_by_percent", "10"]] };
  await expect(readStagingCatalogEvidence(input, "synthetic", request)).rejects.toThrow(
    "unsupported_derived_rate",
  );
});
