import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPgPmsRoomFactsReadModel } from "../../../apps/api/src/domains/pmsRoomFactsReadModel.js";
import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

// Fixed isolated fixture only; never accepts a remote DSN or provider credentials.
const fixtureOrigin = "https://pms.localhost:1380";
const database = "postgresql://postgres@127.0.0.1:59709/vay1009_import_test";
test.skip(
  process.env.E2E_AIRBNB_IMPORT_DATABASE !== "1",
  "Reserved local database smoke is opt-in",
);
test("Airbnb review persists one canonical room and recovers a missing receipt", async ({
  page,
  request,
}) => {
  const { propertyId } = await (await request.get(`${fixtureOrigin}/api/import-demo`)).json();
  const api = `/api/hotel-setup/properties/${propertyId}/airbnb-import`;
  const start = await request.post(`${fixtureOrigin}${api}/start`, {
    headers: { origin: fixtureOrigin },
    data: {},
  });
  expect(start.status()).toBe(200);
  const { url, sourceId } = await start.json();
  expect(new URL(url).origin).toBe("https://marketplace.localhost:1382");
  const review = `${fixtureOrigin}${api}/sources/${sourceId}/review`;
  let submitted: Record<string, unknown> | undefined;
  // Browser session/provider approval are synthetic; every import request reaches real routes/DB.
  await page.route(/\/api\/hotel-setup\/properties\/.*\/airbnb-import\//, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const destination = fixtureOrigin + new URL(route.request().url()).pathname;
    const response = await request.fetch(destination, {
      method: route.request().method(),
      headers: { origin: fixtureOrigin, "content-type": "application/json" },
      ...(route.request().postData() ? { data: route.request().postData()! } : {}),
    });
    if (route.request().method() === "POST" && destination.endsWith("/review")) {
      submitted = route.request().postDataJSON();
      expect(response.status()).toBe(200);
      // The server commits, but the browser loses the response.
      return route.fulfill({ status: 502, headers: corsHeaders(route), json: {} });
    }
    await route.fulfill({ response, headers: { ...response.headers(), ...corsHeaders(route) } });
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Review prepared room data" }).click();
  const before = await (await request.get(review)).json();
  expect(before.import.sourceId).toBe(sourceId);
  const name = `Airbnb DB Suite ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Room name", { exact: true }).fill(name);
  await page.getByLabel("Maximum adults").fill("2");
  await page.getByLabel("Maximum children").fill("0");
  await page.getByLabel("Number of beds").fill("1");
  await page.getByLabel("Bed type").selectOption("queen");
  await page.getByRole("combobox", { name: /^Bathroom/ }).selectOption("private");
  await page.getByRole("checkbox", { name, exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByText(/Import could not finish/)).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("There are no remaining listings to import from this connection."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("There are no remaining listings to import from this connection."),
  ).toBeVisible();
  const saved = await (await request.get(review)).json();
  const roomId = saved.import.results["room:abb_database_suite"].resourceId;
  expect(saved.existingRooms).toHaveLength(before.existingRooms.length + 1);
  expect(saved.existingRooms).toContainEqual({ id: roomId, name });
  const savedFacts = await canonicalRoom(propertyId, roomId);
  expect(savedFacts).toMatchObject({
    facts: {
      name,
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
      beds: [{ type: "queen", quantity: 1 }],
      bathroomType: "private",
    },
  });
  expect(submitted).toBeDefined();
  const db = new pg.Client({ connectionString: database });
  await db.connect();
  try {
    // Remove only this run's synthetic receipt to simulate a crash after room creation.
    const removed = await db.query(
      `DELETE FROM hotel_catalog.airbnb_import_applications application
      USING hotel_catalog.airbnb_import_sources source WHERE application.source_id=source.id
      AND source.id=$1::uuid AND source.property_id=$2::uuid RETURNING application.source_id`,
      [sourceId, propertyId],
    );
    expect(removed.rowCount).toBe(1);
  } finally {
    await db.end();
  }
  const replay = structuredClone(submitted!) as { data: { rooms: { name: string }[] } };
  replay.data.rooms[0]!.name = "Must not overwrite saved room";
  const retried = await Promise.all(
    Array.from({ length: 2 }, () =>
      request.post(review, { headers: { origin: fixtureOrigin }, data: replay }),
    ),
  );
  for (const response of retried) {
    expect(response.status()).toBe(200);
    expect((await response.json()).items[0].resourceId).toBe(roomId);
  }
  const after = await (await request.get(review)).json();
  expect(after.existingRooms).toEqual(saved.existingRooms);
  expect(after.import.results["room:abb_database_suite"].resourceId).toBe(roomId);
  expect(await canonicalRoom(propertyId, roomId)).toEqual(savedFacts);
});
async function canonicalRoom(propertyId: string, roomId: string) {
  const reader = createPgPmsRoomFactsReadModel({ connectionString: database });
  try {
    return await reader.getRoomTypeFacts(propertyId, roomId);
  } finally {
    await reader.close();
  }
}
