import { expect, test } from "@playwright/test";
import { listings } from "./client";
test("real import persists edits and concurrent replay creates no duplicate", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await (await request.get("/api/import-demo")).json();
  const endpoint = `/api/hotel-setup/properties/${fixture.propertyId}/import`;
  await page.goto("/database.html");
  await page.getByRole("button", { name: "Connect Airbnb (simulated)", exact: true }).click();
  await page.getByRole("button", { name: "Simulate approval" }).click();
  await page.getByLabel("Demo Garden Suite").check();
  await page.getByRole("button", { name: "Review selected listings" }).click();
  const before = await (await request.get(endpoint)).json();
  expect(
    before.import.results["room:synthetic-garden"],
    "Start with a fresh dedicated test database; see README",
  ).toBeUndefined();
  await page.getByRole("button", { name: "Review prepared room data" }).click();
  await page.getByLabel("Room name", { exact: true }).fill("Database Garden Suite");
  await page.getByRole("checkbox", { name: "Database Garden Suite", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved in PostgreSQL: 1 room type" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Database Garden Suite", { exact: true })).toBeVisible();
  const body = {
    sourceId: before.import.sourceId,
    data: {
      contractVersion: "prepared-hotel-import.v1",
      property: {},
      rooms: [listings[0]],
    },
  };
  const responses = await Promise.all([
    request.post(endpoint, { data: body }),
    request.post(endpoint, { data: body }),
  ]);
  for (const response of responses) expect(response.status()).toBe(200);
  const after = await (await request.get(endpoint)).json();
  expect(after.existingRooms).toHaveLength(1);
  expect(after.existingRooms[0].name).toBe("Database Garden Suite");
  expect(after.import.results["room:synthetic-garden"].status).toBe("applied");
  await page.screenshot({ path: testInfo.outputPath("database-saved.png"), fullPage: true });
});
test("incomplete, unknown and wrong-property requests cannot add rooms", async ({ request }) => {
  const { propertyId } = await (await request.get("/api/import-demo")).json();
  const endpoint = `/api/hotel-setup/properties/${propertyId}/import`;
  const before = await (await request.get(endpoint)).json();
  const body = {
    sourceId: before.import.sourceId,
    data: {
      contractVersion: "prepared-hotel-import.v1",
      property: {},
      rooms: [listings[1]],
    },
  };
  expect((await request.post(endpoint, { data: body })).status()).toBe(422);
  body.data.rooms = [{ ...listings[0], id: "unknown" }];
  expect((await request.post(endpoint, { data: body })).status()).toBe(404);
  expect(
    (
      await request.post(endpoint, { data: body, headers: { Origin: "https://unrelated.example" } })
    ).status(),
  ).toBe(403);
  const wrong = endpoint.replace(propertyId, "10090000-0000-4000-8000-000000000099");
  expect((await request.post(wrong, { data: body })).status()).toBe(403);
  expect((await request.get("http://127.0.0.1:49709/api/import-demo")).status()).toBe(403);
  const after = await (await request.get(endpoint)).json();
  expect(after.existingRooms).toEqual(before.existingRooms);
});

test("incomplete listing explains which facts need review", async ({ page }) => {
  await page.goto("/database.html");
  await page.getByRole("button", { name: "Connect Airbnb (simulated)", exact: true }).click();
  await page.getByRole("button", { name: "Simulate approval" }).click();
  await page.getByLabel("Demo Loft").check();
  await page.getByRole("button", { name: "Review selected listings" }).click();
  await page.getByRole("button", { name: "Review prepared room data" }).click();
  await expect(page.getByLabel("Maximum guests", { exact: true })).toHaveValue("");
  await page.getByRole("checkbox", { name: "Demo Loft", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("alert")).toContainText("Complete each selected room");
  await expect(
    page.getByRole("heading", { name: "Saved in PostgreSQL: 1 room type" }),
  ).toBeVisible();
});
