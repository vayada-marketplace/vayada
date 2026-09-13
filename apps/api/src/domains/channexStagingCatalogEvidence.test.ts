import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  readStagingCatalogEvidence,
  stagingRevisionHash,
} from "./channexStagingCatalogEvidence.js";
import { input, roomId, rateId, relation, provider } from "./channexStagingCatalogTestFixture.js";
it.each([false, true])(
  "accepts exact Booking.com provider aliases with preImport=%s",
  async (preImport) => {
    const { data, request } = provider();
    for (const name of ["Booking.com", "BookingCom"]) {
      data[`booking_revisions/${input.revisionId}`].attributes.ota_name = name;
      await expect(
        readStagingCatalogEvidence({ ...input, preImport }, "synthetic", request),
      ).resolves.toMatchObject({ roomId, rateId });
    }
    for (const name of ["Airbnb", "BookingCom Other", "", null]) {
      data[`booking_revisions/${input.revisionId}`].attributes.ota_name = name;
      await expect(
        readStagingCatalogEvidence({ ...input, preImport }, "synthetic", request),
      ).rejects.toThrow("invalid_catalog_revision");
    }
  },
);

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
  rate.attributes.meal_type = "breakfast";
  await expect(readStagingCatalogEvidence(input, "synthetic", request)).rejects.toThrow(
    "catalog_meal_mismatch",
  );
  data[`rate_plans/${parentId}`].attributes.meal_type = "breakfast";
  await expect(readStagingCatalogEvidence(input, "synthetic", request)).resolves.toMatchObject({
    mealType: "breakfast",
  });
  rate.attributes.options[0].derived_option = { rate: [["increase_by_percent", "10"]] };
  await expect(readStagingCatalogEvidence(input, "synthetic", request)).rejects.toThrow(
    "unsupported_derived_rate",
  );
});

it("retains breakfast evidence and normalizes room-only aliases without accepting other meals", async () => {
  const { data, request } = provider();
  const rate = data[`rate_plans/${rateId}`].attributes;
  for (const [meal, expected] of [
    ["none", "room_only"],
    ["room_only", "room_only"],
    ["breakfast", "breakfast"],
  ]) {
    rate.meal_type = meal;
    await expect(readStagingCatalogEvidence(input, "synthetic", request)).resolves.toMatchObject({
      mealType: expected,
    });
  }
  for (const meal of ["half_board", "all_inclusive", "unknown", null]) {
    rate.meal_type = meal;
    await expect(readStagingCatalogEvidence(input, "synthetic", request)).rejects.toThrow(
      "unsupported_catalog_meal",
    );
  }
});

it("binds pre-import booking facts deterministically and rejects unsupported booked occupancy", async () => {
  const { data, request } = provider(),
    revision = data[`booking_revisions/${input.revisionId}`];
  const first = await readStagingCatalogEvidence(
    { ...input, preImport: true },
    "synthetic",
    request,
  );
  expect(first.revisionHash).toBe(
    stagingRevisionHash(Object.fromEntries(Object.entries(revision).reverse())),
  );
  revision.attributes.acknowledged_at = "2026-09-13T10:00:00Z";
  expect(stagingRevisionHash(revision)).toBe(first.revisionHash);
  revision.attributes.rooms[0].occupancy.adults = 3;
  await expect(
    readStagingCatalogEvidence({ ...input, preImport: true }, "synthetic", request),
  ).rejects.toThrow("catalog_booked_occupancy_mismatch");
  revision.attributes.rooms[0].occupancy.adults = 2;
  revision.attributes.occupancy = { adults: 2, children: 1 };
  delete revision.attributes.rooms[0].occupancy.children;
  await expect(
    readStagingCatalogEvidence({ ...input, preImport: true }, "synthetic", request),
  ).rejects.toThrow("catalog_booked_occupancy_mismatch");
  revision.attributes.occupancy.children = 0;
  revision.attributes.rooms[0].days = { "2026-09-12": "100.00" };
  expect(
    (await readStagingCatalogEvidence({ ...input, preImport: true }, "synthetic", request))
      .revisionHash,
  ).not.toBe(first.revisionHash);
});

it("recovers only the authorized retained OTA allocation, using catalog probes without a channel", async () => {
  const retainedInput = {
    ...input,
    channelId: undefined,
    retainedRevision: true,
    preImport: true,
    approvalRef: "VAY-2013:test",
  };
  const { request } = provider(true);
  await expect(
    readStagingCatalogEvidence(retainedInput, "synthetic", request),
  ).resolves.toMatchObject({
    roomId,
    rateId,
    recovery: "retained-ota-revision.v1",
    hotelId: "5868189",
    currency: "GBP",
    mealType: "room_only",
  });
  for (const change of [
    { channelId: input.channelId },
    { preImport: false },
    { approvalRef: "VAY-1981:test" },
    { bookingId: input.channelId },
    { revisionId: input.channelId },
    { providerPropertyId: input.channelId },
  ]) {
    const { request } = provider(true);
    await expect(
      readStagingCatalogEvidence({ ...retainedInput, ...change }, "synthetic", request),
    ).rejects.toThrow("invalid_retained_revision_scope");
    expect(request).not.toHaveBeenCalled();
  }
  const changes: ((data: Record<string, any>) => void)[] = [
    (d) => {
      d[`room_types/${roomId}`].attributes.occ_children = 1;
    },
    (d) => {
      d[`room_types/${roomId}`].attributes.occ_adults = 1;
    },
    (d) => {
      d[`booking_revisions/${input.revisionId}`].attributes.channel_id = input.channelId;
    },
    (d) => {
      delete d[`booking_revisions/${input.revisionId}`].attributes.channel_id;
    },
    (d) => {
      d[`booking_revisions/${input.revisionId}`].attributes.is_crs_revision = true;
    },
    (d) => {
      delete d[`booking_revisions/${input.revisionId}`].attributes.is_crs_revision;
    },
    (d) => {
      d[`booking_revisions/${input.revisionId}`].attributes.ota_reservation_code = "5540217040";
    },
    (d) => {
      d[`booking_revisions/${input.revisionId}`].attributes.rooms[0].rate_plan_id = input.channelId;
    },
    (d) => {
      d[`booking_revisions/${input.revisionId}`].attributes.rooms[0].meta.rate_plan_code =
        "16385047";
    },
    (d) => {
      d["channels/mapping_details"].rooms.push(d["channels/mapping_details"].rooms[0]);
    },
    (d) => {
      d["channels/mapping_details"].rooms[0].rates.push(
        d["channels/mapping_details"].rooms[0].rates[0],
      );
    },
    (d) => {
      d["channels/mapping_details"].rooms[0].rates[0].parent_rate_id = "16385046";
    },
    (d) => {
      d["channels/mapping_details"].rooms[0].rates[0].readonly = true;
    },
    (d) => {
      d["channels/mapping_details"].rooms[0].rates[0].max_persons = 1;
    },
    (d) => {
      Object.assign(d[`room_types/${roomId}`].attributes, { occ_adults: 3, default_occupancy: 3 });
      d[`rate_plans/${rateId}`].attributes.options[0].occupancy = 3;
      d[`booking_revisions/${input.revisionId}`].attributes.rooms[0].occupancy.adults = 3;
    },
    (d) => {
      d[`room_types/${roomId}`].attributes.occ_children = 1;
      d[`booking_revisions/${input.revisionId}`].attributes.rooms[0].occupancy.children = 1;
    },
    (d) => {
      d["channels/connection_details"].attributes.currency = "EUR";
    },
    (d) => {
      d[`rate_plans/${rateId}`].attributes.rate_mode = "derived";
    },
    (d) => {
      d[`rate_plans/${rateId}`].relationships.channel = relation(input.channelId);
    },
    (d) => {
      d[`rate_plans/${rateId}`].relationships.property = relation(input.channelId);
    },
    (d) => {
      d[`room_types/${roomId}`].relationships.property = relation(input.channelId);
    },
    (d) => {
      d[`rate_plans/${rateId}`].attributes.meal_type = "breakfast";
    },
  ];
  for (const mutate of changes) {
    const { data, request } = provider(true);
    mutate(data);
    await expect(readStagingCatalogEvidence(retainedInput, "synthetic", request)).rejects.toThrow();
  }
  await expect(
    readStagingCatalogEvidence({ ...input, preImport: true }, "synthetic", provider(true).request),
  ).rejects.toThrow();
});
